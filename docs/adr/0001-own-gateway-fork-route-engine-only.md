# ADR 0001 — Own gateway; fork only the route engine

Date: 2026-09-19 · Status: accepted

## Decision
ChainAim runs its own gateway (`services/gateway`). From BlockRun's open-source
work we fork only `router-core`, renamed `@chainaim/route-engine`
(`packages/route-engine`, MIT notice retained, see its NOTICE). No BlockRun
gateway, wallet, payment or ClawRouter code is used.

## Why
- router-core decides locally with zero runtime dependencies and no network
  calls; it accepts the host's own catalog (pricing, capabilities, tier chains).
- ClawRouter's proxy forwards every prompt to blockrun.ai and is coupled to its
  payment rails (x402 / BlockRun API key); reuse would mean removing most of it.
- The gateway uses Node built-ins only (http, fetch, crypto, util.parseArgs,
  node:test), so the runtime dependency count is zero.

## Consequences
- We own dispatch, health, fallback, ledger and (later) privacy and policy.
- Upstream router-core fixes are merged by hand; the fork is marked
  "ChainAim fork" at each change and pinned to an upstream commit in NOTICE.
- Adapters beyond OpenAI-compatible (e.g. Anthropic Messages API) are our code
  and must be verified against the provider's official docs before use.
