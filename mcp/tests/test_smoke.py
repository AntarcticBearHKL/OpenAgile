"""End-to-end smoke test: boot the real server on a free port and check the
routes the client and an MCP host depend on."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from typing import Any

TOKEN = "smoke-token-123"
ORIGIN = "https://app.example.com"


def _free_port() -> int:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


def _request(method: str, url: str, body: Any = None, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers), err.read()


def _wait_ready(base: str, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            status, _, _ = _request("GET", f"{base}/api/health", headers={"authorization": f"Bearer {TOKEN}"})
            if status == 200:
                return
        except OSError:
            pass
        time.sleep(0.25)
    raise AssertionError("server did not become ready in time")


def test_server_end_to_end() -> None:
    data_dir = tempfile.mkdtemp(prefix="openagile-smoke-")
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    env = {
        **os.environ,
        "OPENAGILE_DATA_DIR": data_dir,
        "OPENAGILE_PORT": str(port),
        "OPENAGILE_HOST": "127.0.0.1",
        "OPENAGILE_TOKEN": TOKEN,
        "OPENAGILE_ORIGINS": ORIGIN,
    }
    process = subprocess.Popen(
        [sys.executable, "-m", "agile_mcp"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        _wait_ready(base)

        # (a) health
        status, _, body = _request("GET", f"{base}/api/health", headers={"authorization": f"Bearer {TOKEN}"})
        assert status == 200
        assert json.loads(body)["code"] == 200

        # auth is enforced
        status, _, _ = _request("GET", f"{base}/api/health")
        assert status == 401

        # (b) harness identity + stats
        status, _, body = _request("GET", f"{base}/api/harness", headers={"authorization": f"Bearer {TOKEN}"})
        assert status == 200
        harness = json.loads(body)
        assert harness["harness"] is True
        assert harness["defaultBoardId"] == "00000000-0000-4000-8000-000000000001"
        assert isinstance(harness["boards"], int)
        assert isinstance(harness["seq"], int)

        # (d) snapshot with the five seeded columns
        status, _, body = _request("GET", f"{base}/api/snapshot", headers={"authorization": f"Bearer {TOKEN}"})
        assert status == 200
        snapshot = json.loads(body)
        assert set(snapshot.keys()) == {"seq", "boardId", "state"}
        assert set(snapshot["state"].keys()) == {"boards", "tasks", "columns", "settings"}
        assert [column["name"] for column in snapshot["state"]["columns"]] == [
            "Backlog",
            "Human In The Loop",
            "In Progress",
            "Blocked",
            "Finished",
        ]

        # groups + skills read routes
        status, _, body = _request("GET", f"{base}/api/groups", headers={"authorization": f"Bearer {TOKEN}"})
        assert status == 200 and "groups" in json.loads(body)
        status, _, body = _request("GET", f"{base}/api/skills", headers={"authorization": f"Bearer {TOKEN}"})
        assert status == 200 and len(json.loads(body)["skills"]) == 6

        # skill documents
        status, headers, body = _request("GET", f"{base}/skill/openagile.md", headers={"authorization": f"Bearer {TOKEN}"})
        assert status == 200
        assert headers["content-type"].startswith("text/markdown")
        assert b"openagile:live-context" not in body
        status, _, body = _request("GET", f"{base}/skill/agent.json", headers={"authorization": f"Bearer {TOKEN}"})
        assert json.loads(body)["mcpEndpointHint"] == f"{base}/mcp"

        # CORS preflight
        status, headers, _ = _request(
            "OPTIONS",
            f"{base}/api/events",
            headers={"origin": ORIGIN, "access-control-request-method": "POST"},
        )
        assert status == 204
        assert headers["access-control-allow-origin"] == ORIGIN
        assert headers["access-control-allow-private-network"] == "true"

        # disallowed origin is refused
        status, _, _ = _request(
            "GET",
            f"{base}/api/groups",
            headers={"authorization": f"Bearer {TOKEN}", "origin": "https://evil.example"},
        )
        assert status == 403

        auth = {"authorization": f"Bearer {TOKEN}"}
        mcp_headers = {"content-type": "application/json", "accept": "application/json, text/event-stream", **auth}

        # (c) MCP initialize + tools/list
        status, headers, body = _request(
            "POST",
            f"{base}/mcp",
            body={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "smoke", "version": "1.0.0"},
                },
            },
            headers=mcp_headers,
        )
        assert status == 200, body
        init = json.loads(body)
        assert init["result"]["serverInfo"]["name"] == "openagile-harness"
        session_id = headers.get("mcp-session-id") or headers.get("Mcp-Session-Id")
        assert session_id

        session_headers = {**mcp_headers, "mcp-session-id": session_id}
        _request("POST", f"{base}/mcp", body={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=session_headers)

        status, _, body = _request(
            "POST",
            f"{base}/mcp",
            body={"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            headers=session_headers,
        )
        assert status == 200, body
        names = [tool["name"] for tool in json.loads(body)["result"]["tools"]]
        assert len(names) == 42
        assert names[0] == "list_boards"
        assert names[-1] == "wait_for_event"
        assert "digest_key_points" in names and "claim_next" in names

        # a tool call round-trips
        status, _, body = _request(
            "POST",
            f"{base}/mcp",
            body={"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_boards", "arguments": {}}},
            headers=session_headers,
        )
        assert status == 200
        result = json.loads(body)["result"]
        assert result.get("isError") is not True

        # SSE stream replays a retry frame then the seeded events
        request = urllib.request.Request(f"{base}/api/stream?since=0&token={TOKEN}", headers={"accept": "text/event-stream"})
        with urllib.request.urlopen(request, timeout=10) as stream:
            chunk = stream.read(96)
        assert chunk.startswith(b"retry: 2000")

        # bridge admission accepts an allowlisted origin + token
        event = {
            "id": "smoke-bridge-event",
            "type": "task.created",
            "hlc": {"wallTime": 10, "counter": 0, "nodeId": "smoke"},
            "at": "2026-01-01T00:00:10.000Z",
            "scope": "board",
            "board_id": "00000000-0000-4000-8000-000000000001",
            "entity_id": "smoke-task",
            "actor": {"type": "human", "id": None},
            "payload": {"task": {"id": "smoke-task", "title": "From the browser", "column": "00000000-0000-4000-8000-000000000034", "order": 1, "keyPoints": [], "needsDigest": False}},
        }
        status, _, body = _request(
            "POST",
            f"{base}/api/events?clientId=smoke",
            body=event,
            headers={"content-type": "application/json", "origin": ORIGIN, **auth},
        )
        assert status == 200, body
        assert json.loads(body)["appended"] == 1
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:  # pragma: no cover
            process.kill()
