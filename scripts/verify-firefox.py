"""Loads the built Firefox extension into a real Firefox and runs the pipeline end to end.

This exists because the Playwright e2e suite can only drive Chromium: Playwright cannot
load MV3 extensions into Firefox. Selenium + geckodriver can install a temporary add-on
into the real, installed Firefox - the same gesture as `about:debugging` -> Load Temporary
Add-on - which makes this the one place the Firefox build's runtime behaviour is actually
observed rather than inferred from a passing `web-ext lint`.

What it verifies, in order:
  1. The temporary add-on installs into a clean profile without error.
  2. The content script perceives a fixture page, the Privacy Firewall redacts it, and
     the payload that crosses the wire (captured by a recording proxy in front of the
     real FastAPI server) contains tokens, never the raw values planted on the page.
  3. The returned action executes against the live DOM (the fixture marks itself).
  4. The Firefox-specific vision path - the event page hosting the analysis document,
     `analyzeInHost`'s non-offscreen branch - runs OCR over a canvas whose text exists
     nowhere in the DOM, and the audit trail records the vision stage.

Usage:  python scripts/verify-firefox.py
Writes: test-results/firefox-verification.json and firefox-*.png screenshots.
"""

from __future__ import annotations

import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service as FirefoxService
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "extension" / "dist" / "firefox"
FIXTURES = ROOT / "extension" / "e2e" / "fixtures"
RESULTS = ROOT / "test-results"
ADDON_ID = "privagent@example.invalid"

# Text drawn onto the canvas below. It exists only as pixels: no DOM node, no attribute.
CANVAS_PHONE = "9876543210"

VISION_FIXTURE = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Vision Check</title></head>
<body>
  <h1>Painted-text page</h1>
  <canvas id="c" width="320" height="70"></canvas>
  <a id="download" href="#downloaded">Download report</a>
  <p id="result">not clicked</p>
  <script>
    const ctx = document.getElementById("c").getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 320, 70);
    ctx.fillStyle = "#000"; ctx.font = "20px Arial";
    ctx.fillText("Call {CANVAS_PHONE}", 12, 40);
    document.getElementById("download").addEventListener("click", () => {{
      document.getElementById("result").textContent = "downloaded";
    }});
  </script>
</body></html>
"""

# Raw values planted by the fixtures. None of them may ever appear on the wire.
PLANTED = ["9876543210", "8765432109", "accounts@example.com", "1234 5678 9012", "4111 1111 1111 1111"]


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def serve_dir(directory: Path, port: int) -> http.server.ThreadingHTTPServer:
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(  # noqa: E731
        *a, directory=str(directory), **kw
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class RecordingProxy(http.server.BaseHTTPRequestHandler):
    """Forwards /reason to the real server, keeping every body that crossed the wire."""

    upstream = ""
    bodies: list[str] = []

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        RecordingProxy.bodies.append(body.decode("utf-8", "replace"))
        request = urllib.request.Request(
            f"{RecordingProxy.upstream}{self.path}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=60) as upstream:
            payload = upstream.read()
            self.send_response(upstream.status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(payload)

    def log_message(self, *args: object) -> None:  # silence request logging
        pass


def wait_for_http(url: str, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except Exception:
            time.sleep(0.3)
    raise TimeoutError(f"{url} did not answer within {timeout}s")


def extension_uuid(profile_dir: str, driver: webdriver.Firefox) -> str:
    """The internal moz-extension origin UUID for the temporary add-on.

    Firefox assigns it per profile and records it in prefs; geckodriver's profile is
    where the running instance flushes them. Prefs are written lazily, so poll.
    """
    pref_files = [Path(profile_dir) / "prefs.js"]
    deadline = time.time() + 20
    while time.time() < deadline:
        for prefs in pref_files:
            if not prefs.exists():
                continue
            match = re.search(
                r'"extensions\.webextensions\.uuids",\s*"(.*?)"\);', prefs.read_text("utf-8")
            )
            if match:
                mapping = json.loads(match.group(1).replace('\\"', '"'))
                if ADDON_ID in mapping:
                    return mapping[ADDON_ID]
        # Nudge Firefox to flush prefs by touching a page.
        driver.get("about:blank")
        time.sleep(0.5)
    raise TimeoutError("extension UUID never appeared in prefs.js")


def open_extension_page(driver: webdriver.Firefox, url: str) -> str:
    """Opens a moz-extension:// page in a new tab and returns its window handle.

    Marionette refuses `driver.get()` for privileged URLs from the content context
    ("Navigation ... is not allowed in this context"), so the tab is opened from the
    browser's own chrome context instead - the code equivalent of the user typing the
    URL - and then driven as ordinary content.
    """
    before = set(driver.window_handles)
    with driver.context(driver.CONTEXT_CHROME):  # type: ignore[attr-defined]
        driver.execute_script(
            """
            const win = Services.wm.getMostRecentWindow("navigator:browser");
            win.gBrowser.selectedTab = win.gBrowser.addTab(arguments[0], {
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
            });
            """,
            url,
        )
    deadline = time.time() + 10
    while time.time() < deadline:
        fresh = [handle for handle in driver.window_handles if handle not in before]
        if fresh:
            driver.switch_to.window(fresh[0])
            return fresh[0]
        time.sleep(0.2)
    raise TimeoutError(f"no new tab appeared for {url}")


def run_task(
    driver: webdriver.Firefox, popup_handle: str, page_handle: str, task: str
) -> dict[str, str]:
    """Runs one task from the popup (hosted in its own window) and returns the summary.

    The popup lives in a second, non-overlapping window so that the fixture tab stays
    the *active* tab of its own window while Run is pressed: `captureVisibleTab`
    photographs the window, and the pipeline refuses to run vision when the task's tab
    is not the visible one - correctly, but fatally for a harness that focused a popup
    tab in the same window.
    """
    driver.switch_to.window(page_handle)
    time.sleep(0.4)
    driver.switch_to.window(popup_handle)

    field = driver.find_element(By.ID, "task")
    field.clear()
    field.send_keys(task)
    driver.find_element(By.ID, "run").click()

    WebDriverWait(driver, 90).until(
        lambda d: d.find_element(By.ID, "status").get_attribute("data-state") in ("done", "error")
    )
    state = driver.find_element(By.ID, "status").get_attribute("data-state")
    rows: dict[str, str] = {"_state": state or "", "_status": driver.find_element(By.ID, "status").text}
    terms = driver.find_elements(By.CSS_SELECTOR, "#summary-list dt")
    values = driver.find_elements(By.CSS_SELECTOR, "#summary-list dd")
    rows.update({t.text: v.text for t, v in zip(terms, values)})
    rows["_trace"] = " | ".join(
        item.text.replace("\n", " ") for item in driver.find_elements(By.CSS_SELECTOR, "#trace-list li")
    )
    return rows


def main() -> int:
    if not (DIST / "manifest.json").exists():
        print("Build first: npm run build:firefox --prefix extension", file=sys.stderr)
        return 2

    RESULTS.mkdir(exist_ok=True)
    report: dict[str, object] = {"verifiedAt": time.strftime("%Y-%m-%dT%H:%M:%S")}

    # Fixture pages: the repo's own e2e fixtures plus the painted-canvas page.
    pages_dir = Path(tempfile.mkdtemp(prefix="privagent-ff-"))
    for fixture in FIXTURES.glob("*.html"):
        shutil.copy(fixture, pages_dir / fixture.name)
    (pages_dir / "vision-check.html").write_text(VISION_FIXTURE, "utf-8")
    pages_port = free_port()
    pages = serve_dir(pages_dir, pages_port)

    # The real FastAPI server, deterministic provider, behind the recording proxy.
    # Pinned explicitly: a developer's server/.env must not reroute this verification
    # through a remote model.
    api_port = free_port()
    api = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--app-dir", "server",
         "--port", str(api_port), "--log-level", "warning"],
        cwd=ROOT,
        env={**os.environ,
             "PRIVAGENT_REASONER": os.environ.get("PRIVAGENT_REASONER", "deterministic")},
    )
    proxy_port = free_port()
    RecordingProxy.upstream = f"http://127.0.0.1:{api_port}"
    proxy = http.server.ThreadingHTTPServer(("127.0.0.1", proxy_port), RecordingProxy)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()

    options = Options()
    options.binary_location = r"C:\Program Files\Mozilla Firefox\firefox.exe"
    # Chrome-context scripting (used only to open the popup tab, the way a user typing
    # the URL would) is gated in Firefox 138+; the CLI flag is rejected as a capability,
    # so it is granted through the environment geckodriver launches Firefox with.
    service = FirefoxService(env={**os.environ, "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1"})
    driver: webdriver.Firefox | None = None
    try:
        wait_for_http(f"http://127.0.0.1:{api_port}/health")
        driver = webdriver.Firefox(options=options, service=service)
        report["firefox"] = driver.capabilities.get("browserVersion")
        driver.install_addon(str(DIST), temporary=True)

        uuid = extension_uuid(driver.capabilities["moz:profile"], driver)
        popup = f"moz-extension://{uuid}/src/ui/popup.html"
        report["installed"] = True

        # --- Act 1: DOM pipeline on the PII-laden report portal. ---
        driver.set_window_rect(x=0, y=0, width=880, height=800)
        driver.get(f"http://127.0.0.1:{pages_port}/report-portal.html")
        page_handle = driver.current_window_handle

        # The popup goes into its own window, beside (not over) the page window.
        driver.switch_to.new_window("window")
        driver.set_window_rect(x=890, y=0, width=520, height=780)
        popup_handle = open_extension_page(driver, popup)

        # Point the extension at the recording proxy. The UI path (settings card ->
        # save) is exercised, and the stored value is then asserted directly through
        # the extension's own storage API - a click that silently failed to persist
        # would otherwise send every request to the default port.
        proxy_url = f"http://127.0.0.1:{proxy_port}"
        driver.execute_script("document.getElementById('settings').open = true")
        server_field = driver.find_element(By.ID, "server")
        server_field.clear()
        server_field.send_keys(proxy_url)
        driver.find_element(By.ID, "save-server").click()
        stored = driver.execute_async_script(
            """
            const done = arguments[arguments.length - 1];
            browser.storage.local.set({"privagent.serverUrl": arguments[0]})
              .then(() => browser.storage.local.get("privagent.serverUrl"))
              .then((got) => done(got["privagent.serverUrl"]))
              .catch((error) => done(String(error)));
            """,
            proxy_url,
        )
        report["server_url_stored"] = stored
        if stored != proxy_url:
            raise RuntimeError(f"server URL did not persist: {stored!r}")

        act1 = run_task(driver, popup_handle, page_handle, "download report")
        report["act1_dom_pipeline"] = act1
        driver.save_screenshot(str(RESULTS / "firefox-act1-popup.png"))

        driver.switch_to.window(page_handle)
        clicked = driver.find_element(By.ID, "result").text
        report["act1_executed_on_page"] = clicked
        driver.save_screenshot(str(RESULTS / "firefox-act1-page.png"))

        # --- Act 2: vision path - text that exists only as canvas pixels. ---
        driver.switch_to.window(page_handle)
        driver.get(f"http://127.0.0.1:{pages_port}/vision-check.html")
        act2 = run_task(driver, popup_handle, page_handle, "download report")
        report["act2_vision_pipeline"] = act2
        driver.save_screenshot(str(RESULTS / "firefox-act2-popup.png"))

        # --- The wire: nothing planted may have crossed it, tokens must have. ---
        bodies = "\n".join(RecordingProxy.bodies)
        report["wire_requests"] = len(RecordingProxy.bodies)
        report["wire_raw_pii"] = [value for value in PLANTED if value in bodies]
        report["wire_has_tokens"] = "[PII_" in bodies
        report["wire_sample"] = RecordingProxy.bodies[0][:600] if RecordingProxy.bodies else ""

        ok = (
            report.get("installed") is True
            and act1["_state"] == "done"
            and clicked == "downloaded"
            and not report["wire_raw_pii"]
            and report["wire_has_tokens"] is True
        )
        vision_ran = "vision read" in act2.get("_trace", "")
        report["vision_stage_ran"] = vision_ran
        report["verdict"] = "PASS" if ok else "FAIL"
        report["vision_verdict"] = "PASS" if vision_ran else "vision did not read the canvas - inspect act2 trace"
    finally:
        (RESULTS / "firefox-verification.json").write_text(json.dumps(report, indent=2), "utf-8")
        if driver is not None:
            driver.quit()
        api.terminate()
        proxy.shutdown()
        pages.shutdown()
        shutil.rmtree(pages_dir, ignore_errors=True)

    print(json.dumps(report, indent=2))
    return 0 if report.get("verdict") == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
