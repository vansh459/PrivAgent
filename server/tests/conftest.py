"""Test-suite hermeticity: force the deterministic provider before the app imports.

`app.main` loads `server/.env` at import, and a developer whose `.env` selects the
Foundry or Ollama provider would otherwise have this suite quietly testing a network
model. The real environment takes precedence over the file, so setting it here - before
any test imports the app - pins every test to the provider it was written against.
Live-model suites (`test_ollama_live.py`) opt in explicitly and are unaffected.
"""

import os

os.environ.setdefault("PRIVAGENT_REASONER", "deterministic")
