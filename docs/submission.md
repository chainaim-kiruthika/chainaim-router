# Submission draft: Global x402 Challenge (Composite entry)

> Before submitting, check every line against what is live: each route listed in the Bazaar, and each route with a real MainNet payment. Delete any sentence that is not yet true.

**Name.** ChainAim Privacy Gateway

**One line.** Pay-per-call privacy for AI agents on Algorand: find and mask personal, health and card data, and chat with models that never see the originals.

**What it does.** Private chat, paid per call in USDC on Algorand MainNet through the GoPlausible facilitator. The chat route is listed in the Bazaar with the tag `x402-global-challenge`, and its first MainNet payment settled on 2026-10-02 (transaction 6TRH6KL4EJU3FFSWO3OJMXCDM4TLPNQXUFJTFYHSV5NV7UVSCNVQ).

- **chat** ($0.01): an OpenAI-compatible chat. The conversation is masked before any model sees it. TypeSafe's Jev (through OpenRouter's Decisions API) classifies the masked request, a scoring table picks among OpenRouter's free models, and the original values are put back into the answer.

The same paywall also serves two smaller routes at $0.01 each. Both quote on MainNet but aren't listed in the Bazaar yet and have no MainNet payment, and chat runs both steps itself:

- **scan**: finds personal, health and card data in a text and returns the entity types, positions, data class and data policy. No model is called.
- **mask**: replaces personal and health identifiers with numbered placeholders, removes card numbers, and returns the map to restore them.

**Privacy.**
- Detection runs on a Presidio analyzer inside ChainAim's private network. Message text and tool-call arguments are never sent anywhere before they are masked, and if the scanner is down, scan, mask and chat are refused.
- Health data only goes to model providers that don't collect data. If none is available, the request is refused and the caller isn't charged.
- Card numbers are removed, never restored.
- The decision ledger records classes and counts, never text.
- The paywall strips payment headers, so the gateway never learns who paid.
- On the user's own computer first: the `private-ask` command masks identity numbers, card numbers and labelled names before anything is sent, and puts them back in the answer locally. The gateway scans again as a second check and keeps masked health data on no-collection providers. Names without a label and medical details still reach the gateway.

**Why x402 is core.** Every call is a paid request with no accounts and no API keys: an agent discovers the service in the Bazaar and pays per call. Settlement happens only after a successful answer, so refusals are free.

**Honest limits.** Detection is automated and can miss values: recall is being measured on a synthetic set, and no compliance certification is claimed. Chat forwards tool definitions, the response_format schema, stop sequences, tool_choice, and tool-call ids and function names as sent, without scanning them. Chat runs on free models with OpenRouter's rate limits, so capacity is limited; the paywall only asks for payment when free-model capacity is available, and any refusal after payment is free.

**Links.** Repository: https://github.com/chainaimdev/chainaim-router · Endpoint: https://privacybuddy.up.railway.app · Web page: https://chainaim-router.vercel.app
