# ADR 0002: OpenRouter free models, and Jev for classification

Date: 2026-09-25 · Status: accepted

## Decision
- **D2.** Every chat answer comes from an OpenRouter free model (id ends in `:free`). No self-hosted or other hosted models in production.
- **D3.** The paid chat endpoint uses those free models without asking OpenRouter first.
- **D9.** Jev never sees a request already classed as health data (PHI); the route engine's rules classify those.

## Why
- D2: API keys only, no inference on hardware ChainAim runs; the service must be up around the clock through October on a managed container platform without a GPU.
- D3: the owner accepts the risk under section 7 of OpenRouter's terms (reselling API access to models). Mitigations: scan and mask never use OpenRouter; chat refuses without charging when the key stops working; the paywall's capacity guard stops payment requests for chat when it cannot be served.
- D9: health text only goes to providers that don't collect data, and TypeSafe has not published a retention policy for Jev.

## Consequences
- Chat volume is capped by OpenRouter's free limits: 20 requests a minute, and 1,000 a day once $10 of credits are bought. Scan and mask carry most of the volume.
- Health-data chat is refused, without charge, whenever no free model has a provider that doesn't collect data. The ledger counts these refusals.
- If OpenRouter suspends the key, chat is unavailable; scan and mask continue.
- The free lineup changes: the pool is re-synced every 6 hours, and unlisted models are scored from the size in their id.
