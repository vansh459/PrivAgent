from fastapi.testclient import TestClient

from app.main import app


def test_health_reports_status_and_active_provider() -> None:
    response = TestClient(app).get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["provider"] == "deterministic"
