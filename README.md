# chainaim-router

ChainAim's model gateway. Clients call one OpenAI-compatible endpoint; the gateway picks the
model (by request shape, profile, capability and health) and orchestrates the call to wherever
that model is deployed.

```
client ──▶ chainaim-gateway :8700 ──▶ @chainaim/route-engine (decide, local, <1 ms)
                  │
                  └─▶ deployment pool (health, least-busy replica, cooldown)
                          ├─▶ llama.cpp / vLLM / Ollama on this machine
                          ├─▶ GPU servers in your cloud
                          └─▶ public APIs (OpenAI-compatible adapters)
```

## Endpoints
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | /v1/privacy/scan | gateway key if set | Entities (type, UTF-16 start/end, score), classes and data policy; no model is called |
| POST | /v1/privacy/mask | gateway key if set | Masked text, placeholder map, counts, cards removed |
| POST | /v1/chat/completions | gateway key if set | Route + dispatch; streaming supported |
| POST | /v1/route/explain | gateway key if set | Decision only; nothing sent to a model |
| GET | /v1/models | gateway key if set | Catalog models + `chainaim/auto`, `chainaim/eco`, `chainaim/premium` |
| GET | /v1/deployments | gateway key if set | Per-deployment health, in-flight, last error |
| GET | /healthz | none | 200 when Presidio answered its last check, else 503 |

Response headers: `x-chainaim-decision-id`, `x-chainaim-model`, `x-chainaim-deployment`,
`x-chainaim-tier`, `x-chainaim-profile`, `x-chainaim-attempts`.

## Model names
- `chainaim/auto` · `chainaim/eco` · `chainaim/premium` — let the gateway choose.
- Any catalog id (e.g. `local/qwen2.5-1.5b`) — pin that model.

## Flags
`node services/gateway/src/main.ts --help` lists every flag and default.
Non-loopback binding is refused unless `--api-key-env` is set.

## Run it on Windows

Node 22.22+ is required (the gateway runs TypeScript directly; older Node cannot).

Easiest path — Ollama:

```powershell
ollama pull qwen2.5:0.5b-instruct
ollama pull qwen2.5:1.5b-instruct
ollama serve                      # if it is not already running as a service
setx OLLAMA_KEEP_ALIVE -1         # keep models resident; see "Cold start" below
node services\gateway\src\main.ts --catalog config\catalog.ollama.json --port 8700
```

**Cold start — read this before your first request.** Ollama sends no response
headers until the model's weights are resident, so a model that is merely
*unloaded* is indistinguishable from a hung upstream. On a cold 0.5B this has
been measured at over 120 s: the first request hits `--attempt-timeout-ms`,
fails over to the next model in the chain, and the ledger records
`"outcome":"timeout"`. The same model answers in under 0.5 s once warm.

Two consequences:

- **The health probe cannot see it.** `config/catalog.ollama.json` sets no
  `healthUrl`, so the pool defaults to `<baseUrl>/models`, which Ollama answers
  instantly whether or not any model is loaded. Server liveness is not model
  readiness; `/v1/deployments` will read healthy throughout a cold-start stall.
- **Idle undoes it.** Ollama's default `keep_alive` is 5 minutes, so an idle
  gateway silently returns to cold and the next request pays the timeout again.

Set `OLLAMA_KEEP_ALIVE=-1` (above) and restart Ollama, or pin a single model
without restarting:

```powershell
curl.exe -X POST http://127.0.0.1:11434/api/generate -H "content-type: application/json" `
  -d "{\"model\":\"qwen2.5:0.5b-instruct\",\"prompt\":\"hi\",\"stream\":false,\"keep_alive\":-1}"
ollama ps    # UNTIL should read "Forever"
```

Raising `--attempt-timeout-ms` does not fix this — it only makes the stall
longer before the same failover. Keep the models warm instead. llama.cpp loads
weights at process start, so `config/catalog.json` does not have this problem.

llama.cpp instead (matches config/catalog.json): download a Windows llama-server build and the
two GGUF files into .\models, then

```powershell
.\scripts\serve-local-models.ps1 -LlamaServer C:\path\to\llama-server.exe -ModelsDir .\models
node services\gateway\src\main.ts --catalog config\catalog.json --port 8700
```

Check it:

```powershell
npm test                                              # 18 gateway tests, real sockets
npm run smoke                                         # 17 checks against a running gateway
curl.exe http://127.0.0.1:8700/healthz
node scripts\iter0-matrix.ts --gateway http://127.0.0.1:8700 --max-tokens 64
```

## Testing without model weights

`scripts/stub-models.ts` serves the two catalog models on ports 8081/8082,
impersonating llama.cpp's wire protocol, so `config/catalog.json` runs against
it unchanged. Answers are echoes — this exercises routing, dispatch, fallback,
health and the ledger, never answer quality. Routing decisions are identical to
a real backend because the engine is deterministic and never sees model output.

```powershell
npm run stub-models                                   # terminal 1
npm run gateway -- --catalog config\catalog.json      # terminal 2
npm run smoke
```

Each stub takes a control endpoint, which is the only way to fail one model
independently (under Ollama both models share one process):

```powershell
curl.exe "http://127.0.0.1:8081/admin/mode?m=fail500" # force 5xx
curl.exe "http://127.0.0.1:8081/admin/mode?m=slow"    # 3 s delay
curl.exe "http://127.0.0.1:8081/admin/mode?m=ok"      # healthy again
```

## Privacy endpoints locally

The gateway needs a Presidio analyzer. Without Docker, the stub detects the synthetic corpus in
`scripts/synthetic-corpus.ts` (never real data):

```powershell
npm run stub-presidio                                   # terminal 1, port 5002
npm run gateway -- --catalog config/catalog.json        # terminal 2
Invoke-RestMethod http://127.0.0.1:8700/v1/privacy/mask -Method Post -ContentType application/json `
  -Body '{"text":"Patient Jane Roe, MRN 991122, was diagnosed with diabetes."}'
```

The gateway refuses to start until Presidio answers and supports every required entity.

## Routing strategies

`--strategy rules` (default) classifies by weighted keyword scoring.
`--strategy portfolio` runs the same classifier, then ranks within the tier and
additionally populates `taskType` and `agentRisk` on the decision — the signals
the planned escalation rules consume. Both are local and sub-millisecond.
Compare them on one prompt with `/v1/route/explain`.

See PROJECT_CONTEXT.md and docs/adr/.
