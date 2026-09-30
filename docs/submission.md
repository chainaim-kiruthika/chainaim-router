# Submission draft: Global x402 Challenge (Composite entry)

> Before submitting, check every line against what is live: each route listed in the Bazaar, and each route with a real MainNet payment. Delete any sentence that is not yet true. If chat is not live on September 29, describe it as launching.

**Name.** ChainAim Privacy Gateway

**One line.** Pay-per-call privacy for AI agents on Algorand: find and mask personal, health and card data, and chat with models that never see the originals.

**What it does.** Three x402 endpoints on one payTo address, paid in USDC on Algorand MainNet through the GoPlausible facilitator, and listed in the Bazaar with the tag `x402-global-challenge`:

- **scan** ($0.01): finds personal, health and card data in a text and returns the entity types, positions, data class and data policy. No model is called.
- **mask** ($0.01): replaces personal and health identifiers with numbered placeholders, removes card numbers, and returns the map to restore them.
- **chat** ($0.01): an OpenAI-compatible chat. The conversation is masked before any model sees it. TypeSafe's Jev (through OpenRouter's Decisions API) classifies the masked request, a scoring table picks among OpenRouter's free models, and the original values are put back into the answer.

**Privacy.**
- Detection runs on a Presidio analyzer inside ChainAim's private network. Message text and tool-call arguments are never sent anywhere before they are masked, and if the scanner is down, scan, mask and chat are refused.
- Health data only goes to model providers that don't collect data. If none is available, the request is refused and the caller isn't charged.
- Card numbers are removed, never restored.
- The decision ledger records classes and counts, never text.
- The paywall strips payment headers, so the gateway never learns who paid.

**Why x402 is core.** Every call is a paid request with no accounts and no API keys: an agent discovers the service in the Bazaar and pays per call. Settlement happens only after a successful answer, so refusals are free.

**Honest limits.** Detection is automated and can miss values: recall is being measured on a synthetic set, and no compliance certification is claimed. Chat forwards tool definitions, the response_format schema, stop sequences, tool_choice, and tool-call ids and function names as sent, without scanning them. Chat runs on free models with OpenRouter's rate limits, so capacity is limited; the paywall only asks for payment when free-model capacity is available, and any refusal after payment is free.

**Links.** Repository: https://github.com/chainaimdev/chainaim-router · Endpoint: https://PAYWALL-DOMAIN (fill in after deployment)
