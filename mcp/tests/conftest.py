"""Test configuration.

``OPENAGILE_DATA_DIR`` is forced to a throwaway directory before any
``agile_mcp`` module is imported, so the suite never touches the repository's
real ``.agileboard``.
"""

from __future__ import annotations

import os
import tempfile

_TMP = tempfile.mkdtemp(prefix="openagile-mcp-test-")
os.environ["OPENAGILE_DATA_DIR"] = _TMP
os.environ["OPENAGILE_TOKEN"] = "test-token"
os.environ["OPENAGILE_ORIGINS"] = "https://app.example.com"
