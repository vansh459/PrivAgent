from pathlib import Path

p = Path("PrivAgent_Build_Specification.md")
t = p.read_text(encoding="utf-8")

pairs = [
    (
        """- [ ] **5.2** Integrate chosen open-weight LLM/VLM (name the specific model and hosting method used).
  - Test criteria: end-to-end call from a sample sanitized payload returns a response within timeout.
  - Notes: 2026-09-04 (Stage 1) - a `ReasonProvider` protocol now exists so a model can be dropped in without touching the endpoint or the client, and `/health` reports which provider is active. Blocker: no model is integrated. `DeterministicProvider`, a keyword matcher, is the only implementation. Ollama with a local open-weight model is the chosen Stage 2 target.""",
        """- [x] **5.2** Integrate chosen open-weight LLM/VLM (name the specific model and hosting method used).
  - Test criteria: end-to-end call from a sample sanitized payload returns a response within timeout.
  - Notes: 2026-09-05 (Stage 2) - **model: `qwen2.5:1.5b` (Qwen2.5-1.5B-Instruct, Apache-2.0, 986 MB quantised). Hosting: Ollama, running locally on the user's own machine at `http://127.0.0.1:11434`.** Local rather than a hosted API on purpose: sending the sanitized context to someone else's inference service would keep "the screen never leaves the device" literally true while handing away the thing the user was protecting - what they are doing, on which page, at what time. **Chosen by measurement, not by reputation:** `scripts/compare-reasoners.py` scores candidates on the same ten payloads with the same prompt, and `llama3.2:1b` scored 3/10 correct at a ~13 s median against qwen's 8/10 at ~7-13 s. Verified end to end **in a real browser against the real model** - `PRIVAGENT_E2E_REASONER=ollama npx playwright test` runs the same loop tests, and the agent perceived, redacted, reasoned and actuated the page in 15.9 s cold. The provider is opt-in (`PRIVAGENT_REASONER=ollama`); the deterministic matcher stays the default so a fresh clone, and CI, get a working server with no model and no download. **The most valuable fix in this task was not the model.** Constrained decoding was already in place, but `target_id` was *optional* in the schema handed to it, and qwen answered `{"action":"click"}` with no target at all - rejected on every attempt, 1/10 usable answers. Making every field required took it to 10/10 usable. An optional field in a schema a decoder enforces is a field the model is free to omit. **Caveats:** a 1.5B model is weak. It gets the risk tier wrong constantly - it called "pay the bill" low risk - which is survivable only because the client takes `max(server, local)` and never lowers it, and it over-acts on tasks the screen cannot serve (2 of the 4 decline cases). Latency is the other cost: ~10 s per call on CPU, against a ~0.5 s whole-task budget without a model.""",
    ),
    (
        """- [ ] **5.3** Design and version the system prompt for structured action output.
  - Test criteria: 10 sample task payloads all produce schema-valid Action JSON (§4.2).
  - Notes: Blocked on 5.2. No system prompt exists because no model is called. The `Action` schema such a prompt must satisfy is defined and enforced on both sides.""",
        """- [x] **5.3** Design and version the system prompt for structured action output.
  - Test criteria: 10 sample task payloads all produce schema-valid Action JSON (§4.2).
  - Notes: 2026-09-05 (Stage 2) - **10/10 payloads produce schema-valid Action JSON**, asserted on the serialized form that actually crosses the wire, in `server/tests/test_ollama_live.py`. The prompt lives in `server/app/prompt.py` at version 1.1, with a `PROMPT_CHANGELOG` recording what changed and why, and the version travels in every `reasoning_trace_id` (`trace_p1.1_ok_...`) so a recorded action can be tied to the wording that produced it. **Two obvious improvements were measured and rejected**, which is the useful half of prompt work: adding a worked example of a *successful* click dropped the score from 8/10 to 5/10, because the model copied the example's mark id into unrelated answers, and elaborating the risk rules with concrete phrases dropped it to 7/10. What worked was one worked example of *declining*, an explicit "does this element's text plainly match" check, and confidence calibration guidance - v1.0 answered everything at confidence 1.0. **Caveat:** the prompt was tuned against these ten payloads, so 8/10 is its score on the cases it was tuned on. A held-out set arrives with the Phase 8.1 dataset.""",
    ),
    (
        """- [ ] **5.4** Implement server-side response schema validation (reject/retry malformed model output).
  - Test criteria: intentionally malformed model output is caught and retried/rejected, never forwarded to client.
  - Notes: 2026-09-04 (Stage 1) - partial. FastAPI validates outbound responses against `Action` via `response_model`, and the client independently re-validates and refuses to execute anything that is not schema-valid (`parseAction`, 4 rejection tests). **Criterion not met:** there is no retry path for malformed model output, because no model produces any. Lands with 5.2.""",
        """- [x] **5.4** Implement server-side response schema validation (reject/retry malformed model output).
  - Test criteria: intentionally malformed model output is caught and retried/rejected, never forwarded to client.
  - Notes: 2026-09-05 (Stage 2) - the retry path exists and is tested against deliberately malformed output, offline, with a scripted transport (`server/tests/test_ollama.py`, 16 tests): prose instead of JSON, a JSON shape the schema rejects, a `type` with no text, and - the one that matters most - **a `target_id` the model invented.** A mark that was never sent would have the client resolve it against whatever element now carries that id, so a hallucinated target is treated as malformed, fed back to the model with the reason, and refused outright on a second failure. There is exactly one retry: a model that has misunderstood twice will misunderstand a third time, and refusing is both faster and safer than eventually accepting something questionable. When it refuses, the client receives a schema-valid `none` action whose explanation says so, rather than an error or a guess. The live test additionally asserts, across all ten payloads, that no action naming an off-screen element ever reaches the client. Validation now happens at four points: constrained decoding, Pydantic on the model's reply, semantic checks against the marks actually sent, and FastAPI's `response_model` on the way out - plus the client's own `parseAction`.""",
    ),
    (
        """- [ ] **5.5** Benchmark server round-trip latency.
  - Test criteria: median round-trip time recorded across 10 tasks; documented against the 15% latency target.
  - Notes: Blocked on 5.2. Round-trip latency measured against a keyword matcher would not describe the system being evaluated.""",
        """- [x] **5.5** Benchmark server round-trip latency.
  - Test criteria: median round-trip time recorded across 10 tasks; documented against the 15% latency target.
  - Notes: 2026-09-05 (Stage 2) - **median 10.4-13.7 s across the ten tasks** with `qwen2.5:1.5b` on CPU (max 16.0 s), and a **10.7 s HTTP round trip** through the real `/reason` endpoint, which puts the server's own overhead - inbound validation, provider dispatch, outbound validation - in the tens of milliseconds. Numbers are written to `test-results/reasoner-benchmark.json` by `npm run test:reasoner` and transcribed into [BENCHMARKS.md](./docs/BENCHMARKS.md). **Against the 15% latency target this is the system's worst result, and it should not be dressed up:** perception is ~250 ms and reasoning is ~10 s, so with a model in the loop the model *is* the latency. The deterministic provider answers the same payloads in ~9 ms, which is why it remains the default. The honest options are a smaller model, a GPU (this machine has none - the same reason WebGPU falls back to SwiftShader), or accepting that an agent which reasons locally is slower than one that ships your screen to a datacentre. Live tests are marked `live` and excluded from the default suite, because a two-minute test suite stops being run.""",
    ),
]

for old, new in pairs:
    assert old in t, old[:70]
    t = t.replace(old, new)

old_gate = """**Phase Gate 5:** ☐ **Open.** 5.1 closed — the endpoint validates strictly in both directions and is verified over real HTTP. 5.2–5.5 all block on the same thing: no model is integrated. The provider seam exists so this is a drop-in, not a rewrite."""
new_gate = """**Phase Gate 5:** ☑ **Closed 2026-09-05.** All five tasks checked. A real open-weight model - Qwen2.5-1.5B-Instruct, hosted locally by Ollama - now reasons over the sanitized context, behind a versioned prompt, with four layers of validation between what it says and what the client will execute. Verified end to end in a real browser: the agent perceived a page, redacted it, asked the local model, and clicked what the model chose.

The gate closes with one result recorded rather than smoothed over: **reasoning is ~10 s and everything else in the loop is ~0.5 s.** A 1.5B model on a CPU is the entire latency budget. The deterministic provider stays the default for that reason, and the model is opt-in - which also keeps a fresh clone and CI working with no download. The model's own risk judgement is unreliable enough that the client's `max(server, local)` rule is doing real work rather than ceremony."""
assert old_gate in t
t = t.replace(old_gate, new_gate)

p.write_text(t, encoding="utf-8")
print("Phase 5 recorded")
