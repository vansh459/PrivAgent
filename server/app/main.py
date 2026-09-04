from fastapi import FastAPI

from .reasoning import reason
from .schemas import Action, SanitizedContext

app = FastAPI(title="PrivAgent API", version="0.1.0")


@app.get("/health")
async def health() -> dict[str, str]:
    """Return the service liveness status without exposing internal state."""
    return {"status": "ok"}


@app.post("/reason", response_model=Action)
async def reason_over_context(context: SanitizedContext) -> Action:
    """Return a schema-validated action for a Privacy Firewall-sanitized context."""
    return reason(context)