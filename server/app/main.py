from fastapi import FastAPI

app = FastAPI(title="PrivAgent API", version="0.1.0")


@app.get("/health")
async def health() -> dict[str, str]:
    """Return the service liveness status without exposing internal state."""
    return {"status": "ok"}
