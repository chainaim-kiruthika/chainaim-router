# PROJECT_CONTEXT — ChainAim model gateway

**What it is.** One OpenAI-compatible endpoint (`chainaim-gateway`) that decides, per request,
which model should answer — self-hosted (llama.cpp, vLLM, Ollama), private cloud, or public
API — and sends it there, with fallback, health checks and a decision ledger.

**Status (2026-09-19).** Iteration 0 complete and running: gateway + forked route engine +
two free local models (Qwen2.5 0.5B / 1.5B via llama.cpp). Evidence: `eval/reports/iter0-2026-09-19T14-36-39-141Z.md`.

## Components (our names)
| Name | Path | Role |
| --- | --- | --- |
| chainaim-gateway | services/gateway | HTTP API, decision, dispatch, fallback, health, ledger |
| @chainaim/route-engine | packages/route-engine | Model selection (fork of BlockRunAI/router-core, MIT) |
| model catalog | config/catalog.json | Models, zones, capabilities, pricing, deployments, profile chains |
| decision ledger | data/ledger/ (gitignored) | One line per request; no prompt/response text |
| Planned: chainaim-sentinel | services/sentinel | Context & prompt analyzer (PII/PHI/PCI, risk) — Iteration 1 |
| Planned: chainaim-vault | services/vault | Placeholder ↔ original map, encrypted, TTL — Iteration 1 |
| Planned: chainaim-policy | packages/policy | Signals → allowed zones/models, escalation — Iteration 1+ |

## Constraints
- No BlockRun gateway, wallet, payment or ClawRouter code. Only router-core is forked.
- Gateway runtime dependencies: none (Node >= 22.22 built-ins; TypeScript run natively).
- Secrets never in config or git: catalog holds env-var NAMES (`apiKeyEnv`) only.
- Real PHI/PII/PCI must not be sent anywhere until Iteration 1 (sentinel + vault) passes its tests.

## Run
```
npm run models:start -- --llama-server /path/to/llama-server --models-dir models
npm run gateway -- --catalog config/catalog.json --port 8700
npm test && npm run test:engine
npm run eval:iter0 -- --gateway http://127.0.0.1:8700
```

## Sources of truth
- Upstream route engine: https://github.com/BlockRunAI/router-core (commit in packages/route-engine/NOTICE)
- llama.cpp server API: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- Decisions: docs/adr/
