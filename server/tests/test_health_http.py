import socket
import subprocess
import threading
import time

import uvicorn

from app.main import app


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def test_health_is_available_over_local_http() -> None:
    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"),
    )
    worker = threading.Thread(target=server.run, daemon=True)
    worker.start()

    try:
        deadline = time.monotonic() + 5
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.05)

        assert server.started, "Uvicorn did not start within five seconds"
        result = subprocess.run(
            ["curl.exe", "--fail", "--silent", "--show-error", f"http://127.0.0.1:{port}/health"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        assert result.stdout == '{"status":"ok"}'
    finally:
        server.should_exit = True
        worker.join(timeout=5)
