"""Entry point for ``agile-mcp`` / ``python -m agile_mcp``."""

from __future__ import annotations

import logging


def main() -> None:
    import uvicorn

    from .app import HOST, PORT, create_app

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    app = create_app()
    uvicorn.run(app, host=HOST, port=PORT, log_level="info", lifespan="on")


if __name__ == "__main__":
    main()
