# PrivAgent API Reference

Server version 0.2.0. Last verified: 2026-09-04, against a running instance.

Base URL: `http://127.0.0.1:8000` by default. Configurable from the extension popup
(Settings → Reasoner URL); stored as `privagent.serverUrl` in extension storage.

The server is local-by-default. It holds no user data and no per-user state.

## `GET /health`

Liveness, plus which reasoning provider is active — useful for confirming whether a demo
is running against a real model or the deterministic fallback.

```console
$ curl http://127.0.0.1:8000/health
{"status":"ok","provider":"deterministic"}
```

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 200  | Service is up. `provider` is `deterministic` today; Stage 2 adds `ollama`. |

## `POST /reason`

Takes a Privacy Firewall-sanitized context, returns one proposed action.

**Request** — `SanitizedContext` ([schema](./DATA_SCHEMAS.md#sanitizedcontext--the-only-payload-that-crosses-the-network)):

```console
$ curl -X POST http://127.0.0.1:8000/reason \
    -H 'Content-Type: application/json' \
    -d '{
      "schema_version": "1.0",
      "task": "download report",
      "elements": [
        {"mark_id":"M1","role":"link","text":"Download report","bbox":[0,0,100,30]}
      ]
    }'
```

**Response** — `Action`:

```json
{
  "action": "click",
  "target_id": "M1",
  "params": {},
  "confidence": 0.8,
  "risk": "low",
  "explanation": "Matched the task to the link labelled 'Download report'.",
  "reasoning_trace_id": "trace_a1b2c3d4e5f6"
}
```

| Code | Meaning                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 200  | A schema-valid `Action`. May be `{"action": "none"}` when nothing matches — the provider declines rather than guessing.                       |
| 422  | The payload failed validation. Includes an unknown field, a `mark_id` not matching `^M\d+$`, a wrong `schema_version`, or a malformed `bbox`. |

Validation is strict in both directions. `extra="forbid"` means an unexpected key is a
422, not a silent ignore — so a client bug that appended a raw value would fail loudly.
The client independently re-validates the response and refuses to execute anything that is
not a schema-valid `Action`.

### Errors the client raises

`background/reason.ts` maps failures to typed `PrivAgentError` codes:

| Code                 | When                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `invalid_response`   | The outbound context failed its pre-flight check, or the response was not a valid `Action`. |
| `server_unreachable` | Connection refused, DNS failure, or the 20 s timeout elapsed.                               |
| `server_rejected`    | Non-2xx response.                                                                           |

## Reasoning providers

`server/app/reasoning.py` defines a `ReasonProvider` protocol so the endpoint does not know
which implementation is behind it.

| Provider                | Status     | Notes                                                                                  |
| ----------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `DeterministicProvider` | **Active** | Keyword matcher over clickable roles. No model, no network. Backs CI and offline runs. |
| `OllamaProvider`        | Stage 2    | A local open-weight model.                                                             |

`set_provider()` swaps the active provider; tests use it, and Stage 2 will select on
startup from configuration.

## CORS

The extension calls from a background service worker whose origin is the extension itself,
so the server allows any origin for `GET` and `POST`. This is acceptable only because the
service is local-by-default and holds no user data — see
[SECURITY.md](./SECURITY.md).
