"""OpenAgile MCP harness — authoritative event-sourced Kanban backend.

Python port of the Node harness in ``kanvana/harness/src``. It owns the
``.agileboard`` event log, projects the read model with the same reducer the
browser uses, and exposes the 42 OpenAgile MCP tools plus the browser bridge
(SSE + ``/api/events``) on one loopback port.
"""

__all__ = ["__version__"]

__version__ = "1.0.0"
