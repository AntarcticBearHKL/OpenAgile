"""The Starlette host — one loopback port serving MCP over Streamable HTTP,
the browser bridge (SSE + ``/api/events``), the snapshot/read routes and the
contextualised skill document.

Port of ``harness/src/server.mjs`` with two deliberate changes (see README):

* the ``POST /api/events`` admission gate is rewritten for a statically hosted
  client (allowlisted ``Origin`` **or** no ``Origin``, plus a bearer token);
* the SSE stream broadcasts every appended event, not only bridge events, so
  agent (MCP) changes reach the browser live — the append listener is the single
  fan-out point and ``?clientId=`` still suppresses the originator's echo.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import hmac
import json
import logging
import os
import secrets
from collections.abc import AsyncIterator
from typing import Any

from mcp import types
from mcp.server.lowlevel import Server
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import store
from .bridge import append_bridge_events, bridge_request_denial
from .constants import DEFAULT_BOARD_ID
from .skill_doc import render_agent_json, render_skill_doc

logger = logging.getLogger("openagile.app")

VERSION = "1.0.0"
HOST = os.environ.get("OPENAGILE_HOST") or "127.0.0.1"
PORT = int(os.environ.get("OPENAGILE_PORT") or os.environ.get("PORT") or 8787)
CLAIM_WATCHDOG_INTERVAL_MS = 30_000

ACCESS_TOKEN = ""


def _parse_origins() -> list[str]:
    raw = os.environ.get("OPENAGILE_ORIGINS") or ""
    return [entry.strip() for entry in raw.split(",") if entry.strip()]


ALLOWED_ORIGINS = _parse_origins()

# ── SSE clients ───────────────────────────────────────────────────────────────

class _SseClient:
    __slots__ = ("queue", "client_id")

    def __init__(self, queue: asyncio.Queue[Any], client_id: str) -> None:
        self.queue = queue
        self.client_id = client_id


_sse_clients: set[_SseClient] = set()
_origin_client: contextvars.ContextVar[str] = contextvars.ContextVar("openagile_origin_client", default="")


def _sse_event(event: dict[str, Any]) -> str:
    return f"id: {event.get('seq')}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"


def _on_store_event(event: dict[str, Any]) -> None:
    origin = _origin_client.get()
    message = _sse_event(event)
    for client in list(_sse_clients):
        if origin and client.client_id == origin:
            continue
        client.queue.put_nowait(message)


def broadcast_groups() -> None:
    payload = json.dumps(store.get_groups_state(), ensure_ascii=False)
    message = f"event: groups\ndata: {payload}\n\n"
    for client in list(_sse_clients):
        client.queue.put_nowait(message)


def broadcast_skills() -> None:
    payload = json.dumps(store.get_skills_state(), ensure_ascii=False)
    message = f"event: skills\ndata: {payload}\n\n"
    for client in list(_sse_clients):
        client.queue.put_nowait(message)


async def _watchdog_loop() -> None:
    while True:
        await asyncio.sleep(CLAIM_WATCHDOG_INTERVAL_MS / 1000)
        try:
            store.sweep_stale_claims()
        except Exception:  # noqa: BLE001
            logger.exception("[harness] claim watchdog failed")


# ── MCP server ────────────────────────────────────────────────────────────────


async def _handle_list_tools(ctx: Any, params: Any) -> types.ListToolsResult:
    from .tools import build_mcp_tools

    return types.ListToolsResult(tools=build_mcp_tools())


async def _handle_call_tool(ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
    from .tools import call_tool

    return await call_tool(params.name, params.arguments or {})


def _build_mcp_session_manager() -> Any:
    server = Server(
        "openagile-harness",
        version=VERSION,
        on_list_tools=_handle_list_tools,
        on_call_tool=_handle_call_tool,
    )
    transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["127.0.0.1:*", "localhost:*", "[::1]:*", "127.0.0.1", "localhost", "[::1]"],
        allowed_origins=[],
    )
    # Instantiating the app creates the session manager the host lifespan runs.
    server.streamable_http_app(
        streamable_http_path="/",
        json_response=True,
        stateless_http=False,
        transport_security=transport_security,
        host="127.0.0.1",
    )
    return server, server.session_manager


# ── CORS + auth middleware (pure ASGI, streaming-safe) ────────────────────────

_PROTECTED_PREFIXES = ("/api/", "/skill/")
_CORS_METHODS = "GET, POST, OPTIONS, DELETE"
_CORS_HEADERS = "content-type, authorization, mcp-session-id, mcp-protocol-version"


def _token_from_scope(scope: Scope, headers: Headers) -> str:
    authorization = headers.get("authorization") or ""
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    query = scope.get("query_string") or b""
    for pair in query.decode("latin-1").split("&"):
        if pair.startswith("token="):
            from urllib.parse import unquote_plus

            return unquote_plus(pair[len("token="):])
    return ""


def _is_protected(path: str) -> bool:
    if path == "/mcp" or path.startswith("/mcp/"):
        return True
    return any(path == prefix[:-1] or path.startswith(prefix) for prefix in _PROTECTED_PREFIXES)


class SecurityMiddleware:
    """Origin allowlist + bearer token, applied to ``/api/*``, ``/skill/*`` and
    ``/mcp``. ``OPTIONS`` preflight is answered before auth and advertises
    ``Access-Control-Allow-Private-Network: true`` for Chrome's Local Network
    Access prompt."""

    def __init__(self, app: ASGIApp, token: str, allowed_origins: list[str]) -> None:
        self.app = app
        self.token = token
        self.allowed_origins = allowed_origins

    def _cors_headers(self, origin: str) -> list[tuple[bytes, bytes]]:
        return [
            (b"access-control-allow-origin", origin.encode("latin-1")),
            (b"vary", b"Origin"),
            (b"access-control-allow-methods", _CORS_METHODS.encode()),
            (b"access-control-allow-headers", _CORS_HEADERS.encode()),
            (b"access-control-expose-headers", b"mcp-session-id"),
            (b"access-control-allow-private-network", b"true"),
        ]

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path") or "/"
        if not _is_protected(path):
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        origin = headers.get("origin")
        method = (scope.get("method") or "GET").upper()

        if origin and origin not in self.allowed_origins:
            await self._send(scope, send, 403, {"error": f"Origin not allowed: {origin}"}, [])
            return

        cors = self._cors_headers(origin) if origin else []

        if method == "OPTIONS":
            await self._send(scope, send, 204, None, cors)
            return

        if self.token:
            provided = _token_from_scope(scope, headers)
            if not hmac.compare_digest(provided.encode("utf-8"), self.token.encode("utf-8")):
                await self._send(scope, send, 401, {"error": "Unauthorized"}, cors)
                return

        if cors:
            async def send_with_cors(message: Message) -> None:
                if message["type"] == "http.response.start":
                    message = dict(message)
                    message["headers"] = [*message.get("headers", []), *cors]
                await send(message)

            await self.app(scope, receive, send_with_cors)
            return

        await self.app(scope, receive, send)

    async def _send(self, scope: Scope, send: Send, status: int, body: Any, extra: list[tuple[bytes, bytes]]) -> None:
        if body is None:
            response = Response(status_code=status)
        else:
            response = JSONResponse(body, status_code=status)
        response.raw_headers = [*response.raw_headers, *extra]
        await response(scope, receive=_never_receive, send=send)


async def _never_receive() -> Message:  # pragma: no cover - only used for fixed responses
    return {"type": "http.disconnect"}


# ── JSON body helper ──────────────────────────────────────────────────────────


async def _read_json_body(request: Request) -> Any:
    try:
        body = await request.body()
    except Exception:  # noqa: BLE001
        return _MISSING
    if not body.strip():
        return None
    try:
        return json.loads(body)
    except ValueError:
        return _MISSING


class _Missing:
    pass


_MISSING = _Missing()


# ── Routes ────────────────────────────────────────────────────────────────────


async def api_health(request: Request) -> Response:
    return JSONResponse({"code": 200, "message": "API is healthy.", "data": {}})


async def api_harness(request: Request) -> Response:
    return JSONResponse(
        {"harness": True, "name": "openagile-harness", "version": VERSION, "defaultBoardId": DEFAULT_BOARD_ID, **store.get_stats()}
    )


async def api_groups(request: Request) -> Response:
    if request.method == "GET":
        return JSONResponse(store.get_groups_state())
    body = await _read_json_body(request)
    if body is _MISSING:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    if not isinstance(body, dict) or not isinstance(body.get("groups"), list):
        return JSONResponse({"error": "groups must be an array"}, status_code=400)
    if "boardGroups" in body and not isinstance(body.get("boardGroups"), dict):
        return JSONResponse({"error": "boardGroups must be an object"}, status_code=400)
    store.set_groups(body["groups"])
    store.set_board_group_map(body.get("boardGroups"))
    broadcast_groups()
    return JSONResponse(store.get_groups_state())


async def api_skills(request: Request) -> Response:
    if request.method == "GET":
        return JSONResponse(store.get_skills_state())
    body = await _read_json_body(request)
    if body is _MISSING:
        return JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    if not isinstance(body, dict) or not isinstance(body.get("skills"), list):
        return JSONResponse({"error": "skills must be an array"}, status_code=400)
    store.set_skills(body["skills"])
    broadcast_skills()
    return JSONResponse(store.get_skills_state())


async def skill_markdown(request: Request) -> Response:
    text = render_skill_doc(request.query_params.get("group") or "")
    return Response(content=text, media_type="text/markdown", headers={"cache-control": "no-cache"})


async def skill_agent_json(request: Request) -> Response:
    host = request.headers.get("host") or f"{HOST}:{PORT}"
    return JSONResponse(render_agent_json(f"http://{host}"))


async def api_stream(request: Request) -> Response:
    raw_since = request.headers.get("last-event-id") or request.query_params.get("since") or "0"
    try:
        since = float(raw_since)
    except (TypeError, ValueError):
        since = 0
    client_id = request.query_params.get("clientId") or ""
    queue: asyncio.Queue[Any] = asyncio.Queue()
    client = _SseClient(queue, client_id)
    _sse_clients.add(client)

    async def generator() -> AsyncIterator[str]:
        try:
            yield "retry: 2000\n\n"
            for event in store.get_events_since(since):
                yield _sse_event(event)
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=20)
                except (asyncio.TimeoutError, TimeoutError):
                    yield ": ping\n\n"
                    continue
                if message is None:
                    break
                yield message
        finally:
            _sse_clients.discard(client)

    return StreamingResponse(
        generator(),
        headers={
            "cache-control": "no-cache, no-transform",
            "connection": "keep-alive",
            "x-accel-buffering": "no",
        },
    )


async def api_snapshot(request: Request) -> Response:
    boards = store.get_boards()
    requested = request.query_params.get("boardId") or (boards[0]["id"] if boards else DEFAULT_BOARD_ID)
    return JSONResponse(store.get_snapshot(requested))


async def api_events(request: Request) -> Response:
    origin = request.headers.get("origin")
    denial = bridge_request_denial(origin, ALLOWED_ORIGINS)
    if denial:
        return JSONResponse({"ok": False, "error": denial}, status_code=403)
    body = await _read_json_body(request)
    if body is _MISSING:
        return JSONResponse({"ok": False, "error": "Invalid JSON body"}, status_code=400)
    client_id = request.query_params.get("clientId") or ""
    token = _origin_client.set(client_id)
    try:
        appended = append_bridge_events(body)
    except ValueError as err:
        return JSONResponse({"ok": False, "error": str(err)}, status_code=422)
    finally:
        _origin_client.reset(token)
    return JSONResponse({"ok": True, "appended": len(appended), "seq": store.get_seq()})


async def api_not_found(request: Request) -> Response:
    return JSONResponse({"error": "Not found"}, status_code=404)


async def not_found(request: Request) -> Response:
    return JSONResponse({"error": "Not found"}, status_code=404)


# ── App factory ───────────────────────────────────────────────────────────────


def create_app() -> Starlette:
    global ACCESS_TOKEN

    token = os.environ.get("OPENAGILE_TOKEN")
    if not token:
        token = secrets.token_urlsafe(32)
        print(f"[harness] OPENAGILE_TOKEN not set; generated token: {token}", flush=True)
    ACCESS_TOKEN = token

    from .tools import set_broadcast_groups

    set_broadcast_groups(broadcast_groups)

    server, session_manager = _build_mcp_session_manager()
    mcp_asgi = _MCPAsgi(session_manager)

    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        boot = store.init_store()
        print(
            f"[harness] listening on http://{HOST}:{PORT}\n"
            f"[harness]   MCP      : http://{HOST}:{PORT}/mcp\n"
            f"[harness]   SSE      : http://{HOST}:{PORT}/api/stream\n"
            f"[harness]   board    : {boot['boardId']} (events: {boot['events']}, seq: {boot['seq']})",
            flush=True,
        )
        unsubscribe = store.subscribe_events(_on_store_event)
        watchdog = asyncio.create_task(_watchdog_loop())
        try:
            async with session_manager.run():
                yield
        finally:
            watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watchdog
            unsubscribe()
            store.flush_store()
            for client in list(_sse_clients):
                client.queue.put_nowait(None)

    routes = [
        # A class-instance endpoint is treated as a raw ASGI app with no method
        # restriction, so POST/GET/DELETE /mcp all reach the session manager.
        Route("/mcp", mcp_asgi),
        Route("/mcp/", mcp_asgi),
        Route("/api/health", api_health, methods=["GET"]),
        Route("/api/harness", api_harness, methods=["GET"]),
        Route("/api/groups", api_groups, methods=["GET", "POST"]),
        Route("/api/skills", api_skills, methods=["GET", "POST"]),
        Route("/skill/openagile.md", skill_markdown, methods=["GET"]),
        Route("/skill/agent.json", skill_agent_json, methods=["GET"]),
        Route("/api/stream", api_stream, methods=["GET"]),
        Route("/api/snapshot", api_snapshot, methods=["GET"]),
        Route("/api/events", api_events, methods=["POST"]),
        Route("/api/{rest:path}", api_not_found, methods=None),
        Route("/{rest:path}", not_found, methods=None),
    ]

    app = Starlette(routes=routes, lifespan=lifespan)
    app.add_middleware(SecurityMiddleware, token=token, allowed_origins=ALLOWED_ORIGINS)
    return app


class _MCPAsgi:
    """Raw ASGI shim so the host lifespan owns ``session_manager.run()``."""

    def __init__(self, session_manager: Any) -> None:
        self.session_manager = session_manager

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        await self.session_manager.handle_request(scope, receive, send)
