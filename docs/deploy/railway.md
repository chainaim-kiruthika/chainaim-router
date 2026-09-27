# Deploying on Railway

Three services in one Railway project, on its private network. Only the paywall is public. Fly.io works the same way (spec section 10).

| Service (exact name) | Root directory | Config file | Public | Variables |
|---|---|---|---|---|
| `presidio` | `services/presidio` | `services/presidio/railway.json` | no | `PORT=3000` |
| `gateway` | `/` | `services/gateway/railway.json` | no | `CHAINAIM_GATEWAY_KEY` (secret); `OPENROUTER_API_KEY` (secret, needed when chat launches) |
| `paywall` | `services/paywall` | `services/paywall/railway.json` | yes | `AVM_PAY_TO`, `X402_NETWORK`, `FACILITATOR_URL`, `GATEWAY_URL`, `PUBLIC_BASE_URL`, `CHAINAIM_GATEWAY_KEY` |

The service names matter: the gateway reaches `presidio.railway.internal:3000`, and the paywall reaches `gateway.railway.internal:8700`.

## 1. Before you start

- The repository is on GitHub (Railway builds from it, and the challenge asks for the link).
- A payTo account: an Algorand address you control. For MainNet it must be opted in to USDC (ASA 31566704).
- A separate buyer account for test payments (self-payments don't count for the challenge). `node scripts/new-account.ts` in `services/paywall` makes one with the 25 words `pay.ts` reads. On TestNet, fund it with ALGO and USDC from the TestNet dispensers.
- A gateway key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

## 2. Create the services

1. New project, then "Deploy from GitHub repo", then this repository and branch.
2. `presidio`: Settings, Source, Root Directory `services/presidio`; Config-as-code path `services/presidio/railway.json`; variable `PORT=3000`; memory 2 GB. No public domain.
3. `gateway`: Root Directory `/`; config path `services/gateway/railway.json`; add a Volume mounted at `/data` (the decision ledger); variable `CHAINAIM_GATEWAY_KEY` = your key. No public domain.
4. `paywall`: Root Directory `services/paywall`; config path `services/paywall/railway.json`; Networking, Generate Domain. Variables:
   - `AVM_PAY_TO` = your payTo address
   - `X402_NETWORK` = `testnet` (switch to `mainnet` in step 5)
   - `FACILITATOR_URL` = `https://facilitator.goplausible.xyz`
   - `GATEWAY_URL` = `http://gateway.railway.internal:8700`
   - `PUBLIC_BASE_URL` = `https://<the generated domain>`
   - `CHAINAIM_GATEWAY_KEY` = `${{gateway.CHAINAIM_GATEWAY_KEY}}` (a reference to the gateway's value)

Every service uses the restart policy "always" (set in its `railway.json`). Expect about $10 to $25 a month, mostly Presidio's memory.

## 3. Check it

```bash
curl https://<domain>/healthz                     # {"status":"ok"} once Presidio is up
curl -si -X POST https://<domain>/v1/privacy/scan -H "content-type: application/json" -d '{"text":"hi"}' | grep -i payment-required
cd services/paywall && npm install && node scripts/pay.ts --dry-run https://<domain>/v1/privacy/scan '{"text":"hi"}'
```

The dry run prints the price (0.002 USDC), the asset, the network, your payTo and `tag=x402-global-challenge`. If the gateway can't start, its log names the missing Presidio entity, the entity types Presidio did not detect in its start-up test sentence, or the unreachable Presidio.

## 4. Pay on TestNet

```bash
cd services/paywall
read -rsp "Buyer's 25 words: " AVM_MNEMONIC && export AVM_MNEMONIC && node scripts/pay.ts https://<domain>/v1/privacy/scan '{"text":"Patient Jane Roe, MRN 991122, was diagnosed with diabetes."}'
```

Expect `HTTP 200`, the scan result and a payment line with a transaction id. A correct scan result has `dataClass` `PHI`, and its `counts` include PERSON, MEDICAL_RECORD and HEALTH_TERM for this synthetic sentence; anything less means Presidio is not detecting as it should. The paywall's log shows one `payment_settled` line.

## 5. Switch to MainNet

1. Set `X402_NETWORK=mainnet` and `AVM_PAY_TO` to the MainNet payTo account (opted in to USDC). The service redeploys.
2. Make one real payment per live route from the separate buyer account: scan and mask now, chat when it launches. The challenge tag is written at settlement, so it is already on the first payment.
3. Check the Bazaar: `curl 'https://facilitator.goplausible.xyz/discovery/resources?limit=100'` and look for your domain.

## 6. Monitor

Create a free UptimeRobot HTTP monitor on `https://<domain>/healthz` every 5 minutes with email alerts. The paywall proxies it to the gateway, which checks Presidio, so it covers all three services. Add a second monitor on `GET https://<domain>/v1/models`: it is free and goes through the gateway key, so it catches a wrong `CHAINAIM_GATEWAY_KEY`, which `/healthz` (no key) cannot see.

## 7. When chat launches

The gateway image runs with `--model-source openrouter-free`. Until `OPENROUTER_API_KEY` is set on the gateway, chat reports no capacity and the paywall refuses chat calls without charging; scan and mask are unaffected. To launch chat: buy $10 of OpenRouter credits (1,000 free-model requests a day), add `OPENROUTER_API_KEY` to the gateway, redeploy it, and run `npm run verify:openrouter` from your PC with the same key (V1, V2 and V5). Then make one real MainNet payment on chat.
