from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_reason_returns_a_schema_valid_action_for_sanitized_context() -> None:
    response = client.post(
        "/reason",
        json={
            "schemaVersion": "1.0",
            "task": "click download",
            "elements": [{"markId": "M1", "role": "button", "text": "Download report", "bbox": [0, 0, 10, 10]}],
        },
    )
    assert response.status_code == 200
    assert response.json()["action"] == "click"
    assert response.json()["target_id"] == "M1"


def test_reason_rejects_malformed_payload() -> None:
    response = client.post("/reason", json={"task": "click"})
    assert response.status_code == 422
