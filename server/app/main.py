from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import env as _env  # noqa: F401 - loads server/.env before providers read os.environ
from .prompt import SYSTEM_PROMPT_VERSION
from .reasoning import get_provider, reason
from .schemas import Action, SanitizedContext

app = FastAPI(title="PrivAgent API", version="0.2.0")

# The extension calls this from a background service worker, whose origin is the
# extension itself. Allowing any origin is acceptable only because the service is
# local-by-default and holds no user data; see docs/SECURITY.md.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    """Return liveness plus which reasoner is answering, and under which prompt.

    The provider name is not internal detail: an action proposed by a keyword matcher and
    one proposed by a language model are different claims, and whoever is reading a trace
    needs to know which they are looking at.
    """
    return {
        "status": "ok",
        "provider": get_provider().name,
        "prompt_version": SYSTEM_PROMPT_VERSION,
    }


@app.post("/reason", response_model=Action)
async def reason_over_context(context: SanitizedContext) -> Action:
    """Return a schema-validated action for a Privacy Firewall-sanitized context."""
    return reason(context)
