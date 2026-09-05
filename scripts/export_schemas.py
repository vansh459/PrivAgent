"""Export the authoritative Pydantic models to JSON Schema on stdout.

Consumed by `scripts/gen-schemas.mjs`. Output is sorted so regenerating an unchanged
contract produces a byte-identical file, which is what the CI drift check relies on.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from app.schemas import EXPORTED_MODELS  # noqa: E402


def main() -> None:
    bundle = {name: model.model_json_schema() for name, model in EXPORTED_MODELS.items()}
    json.dump(bundle, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
