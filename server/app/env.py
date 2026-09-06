"""Loads `server/.env` into the process environment, if the file exists.

Hand-rolled on purpose: the project needs exactly one behaviour - read KEY=VALUE lines
from an untracked file so an API key never has to live in a shell profile or a commit -
and taking a dependency for fifteen lines would be the heavier choice.

Precedence: a variable already set in the real environment wins over the file, so
`PRIVAGENT_REASONER=deterministic pytest` still means what it says on a machine whose
`.env` selects a model. Imported for its side effect by `app.main`, before any module
that reads the environment at import time.
"""

from __future__ import annotations

import os
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def load_env_file(path: Path = ENV_FILE) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file()
