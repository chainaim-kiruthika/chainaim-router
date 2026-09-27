# Set up ChainAim on your machine

This guide gets the ChainAim privacy gateway running on your own computer:
the tests, a local copy of all three services, and, if you want, a TestNet
payment. Nothing here needs an account or an API key, and every example uses
made-up data.

## What runs where

| Part | Folder | What it does | Local port |
|---|---|---|---|
| Presidio analyzer | `services/presidio` | Finds personal, health and card data in text | 5002 |
| Gateway | `services/gateway` | Scan, mask and private chat; never public | 8700 |
| Paywall | `services/paywall` | x402 payments in USDC on Algorand; the only public part | 8080 |

Without Docker, two stand-ins replace the outside services:
`scripts/stub-presidio.ts` (port 5002) and `scripts/stub-openrouter.ts`
(port 5003, chat models that echo what they receive).

## 1. What you need

- **Git**
- **Node.js 24** (22.22 or newer works). The gateway runs its TypeScript
  directly: no build step and no npm packages.
- **Docker Desktop**, only for the real Presidio scanner and the production
  images. The Presidio image is about 1.6 GB and needs about 2 GB of memory.
- **Free ports** 5002, 5003, 8700 and 8080.
- On **Windows**, run the commands in **Git Bash** (PowerShell notes are at
  the end).

```bash
node --version
```

## 2. Get the code and install

```bash
git clone https://github.com/chainaimdev/chainaim-router.git
```

```bash
cd chainaim-router
```

The gateway needs nothing installed. The paywall uses Hono and the official
x402 libraries:

```bash
npm --prefix services/paywall install
```

Optional, for the route engine's own tests:

```bash
npm --prefix packages/route-engine install
```

## 3. Run the tests

```bash
npm test
```
The gateway: 257 tests in about 5 seconds.

```bash
npm run test:paywall
```
The paywall: 24 tests.

```bash
npm run test:engine
```
Optional: the route engine (needs its install from step 2).

The tests use local stand-ins only, never the internet, and all test data is
made up (`scripts/synthetic-corpus.ts`).

## 4. Run it locally with the stand-ins (no Docker, no keys)

Open three terminals in the project folder. Stop each one with Ctrl+C when
you are done.

Terminal 1, the stand-in scanner:

```bash
npm run stub-presidio
```

Terminal 2, the stand-in chat models:

```bash
npm run stub-openrouter
```

Terminal 3, the gateway (`sk-or-dummy` is a made-up key only the stand-in
sees):

```bash
OR_DUMMY=sk-or-dummy node services/gateway/src/main.ts --model-source openrouter-free --openrouter-base-url http://127.0.0.1:5003 --openrouter-key-env OR_DUMMY
```

The gateway listens on http://127.0.0.1:8700. Run locally like this, it asks
for no key of its own. In a fourth terminal, run the smoke test:

```bash
node scripts/smoke.ts --chat
```
Expect `7 passed, 0 failed`.

Try it yourself:

```bash
curl -s -X POST http://127.0.0.1:8700/v1/privacy/mask -H "content-type: application/json" -d '{"text":"Patient Jane Roe, MRN 991122, was diagnosed with diabetes."}'
```

```bash
curl -s -X POST http://127.0.0.1:8700/v1/chat/completions -H "content-type: application/json" -d '{"messages":[{"role":"user","content":"Remind Jane Roe about her diabetes check."}]}'
```

What to expect:

- The stand-in scanner only knows the made-up values in
  `scripts/synthetic-corpus.ts` (Jane Roe, MRN 991122, jane.roe@example.com,
  the card 4111 1111 1111 1111, and so on). To test with any text, use the
  real scanner (step 5).
- The stand-in chat model answers `echo: <what it received>`, and the gateway
  puts your original values back, so the answer shows your own text.
- The gateway writes one line per request to `data/ledger/` (never
  committed). It holds classes, counts and model names, never text.

## 5. Use the real Presidio scanner (Docker)

Stop the stand-in scanner (terminal 1), then build and start the real one:

```bash
docker build -t chainaim-presidio services/presidio
```

```bash
docker run -d --name presidio -p 127.0.0.1:5002:3000 chainaim-presidio
```

It needs about a minute to load. Then check it:

```bash
npm run verify:presidio
```

Expect every line `ok` except `phi-quoted`. That item hides a record number
inside a file path (`C:` then `records` then `991122.txt`), which the real
analyzer does not catch, so the check currently ends with one FAIL and exit
code 1. That is a known limit of automated detection, not a broken setup.

Restart the gateway (terminal 3) with the same command as in step 4. At
start-up it waits for Presidio (up to 2 minutes) and checks that Presidio
finds a name, an email and a medical record number in a made-up test
sentence. If it does not, the gateway refuses to start and names the missed
types. Now any text works:

```bash
curl -s -X POST http://127.0.0.1:8700/v1/privacy/scan -H "content-type: application/json" -d '{"text":"Call Sarah Lee at 415-555-0199 about her asthma."}'
```

Stop the scanner later with:

```bash
docker rm -f presidio
```

## 6. Run the production images (Docker, like the deployment)

This runs the three images the deployment uses, on a private Docker network
with the same host names as Railway. Stop anything from steps 4 and 5 first
(ports 5002 and 8700).

```bash
docker network create chainaim
```

```bash
docker build -t chainaim-presidio services/presidio
```

```bash
docker build -t chainaim-gateway -f services/gateway/Dockerfile .
```

```bash
docker build -t chainaim-paywall services/paywall
```

Make a gateway key for this terminal session (both containers get the same
one, and it is never printed):

```bash
export CHAINAIM_GATEWAY_KEY=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")
```

Start the three services. For `AVM_PAY_TO`, use an Algorand TestNet address
of yours (58 capital letters and digits):

```bash
docker run -d --name ca-presidio --network chainaim --network-alias presidio.railway.internal chainaim-presidio
```

```bash
docker run -d --name ca-gateway --network chainaim --network-alias gateway.railway.internal -e CHAINAIM_GATEWAY_KEY -v chainaim-ledger:/data -p 127.0.0.1:8700:8700 chainaim-gateway
```

```bash
docker run -d --name ca-paywall --network chainaim -e AVM_PAY_TO=YOUR_TESTNET_ADDRESS -e X402_NETWORK=testnet -e GATEWAY_URL=http://gateway.railway.internal:8700 -e CHAINAIM_GATEWAY_KEY -p 127.0.0.1:8080:8080 chainaim-paywall
```

The gateway port is published here only so you can test it; in the
deployment the gateway stays private. The gateway starts without an
OpenRouter key on purpose: scan and mask work, and chat reports that it is
unavailable. Check it:

```bash
docker logs ca-gateway
```
Expect `OPENROUTER_API_KEY is not set: chat is unavailable; scan and mask
work`, then `listening on http://:::8700`.

```bash
curl -s http://127.0.0.1:8080/healthz
```
Expect `{"status":"ok"}`.

```bash
curl -si -X POST http://127.0.0.1:8080/v1/privacy/scan -H "content-type: application/json" -d '{"text":"hi"}'
```
Expect `HTTP/1.1 402 Payment Required` and a `payment-required` header: the
paywall asks for 0.002 USDC before it runs a scan.

Call the gateway directly, with its key:

```bash
curl -s -X POST http://127.0.0.1:8700/v1/privacy/mask -H "authorization: Bearer $CHAINAIM_GATEWAY_KEY" -H "content-type: application/json" -d '{"text":"Call Sarah Lee at 415-555-0199 about her asthma."}'
```

Chat in this setup needs a real OpenRouter key on the gateway
(`-e OPENROUTER_API_KEY`); see `docs/deploy/railway.md`, step 7. Stop
everything with:

```bash
docker rm -f ca-paywall ca-gateway ca-presidio
```

## 7. The paywall with Node, and a payment check

To put the paywall in front of the gateway from step 4 or 5 without Docker
(that gateway checks no key, so any value works for `CHAINAIM_GATEWAY_KEY`):

```bash
cd services/paywall && AVM_PAY_TO=YOUR_TESTNET_ADDRESS X402_NETWORK=testnet GATEWAY_URL=http://127.0.0.1:8700 CHAINAIM_GATEWAY_KEY=local HOST=127.0.0.1 npm start
```

The paywall listens on http://127.0.0.1:8080 and needs internet access to
reach the GoPlausible facilitator. A dry run shows what a call costs and pays
nothing (run it from `services/paywall`):

```bash
node scripts/pay.ts --dry-run http://127.0.0.1:8080/v1/privacy/scan '{"text":"Jane Roe"}'
```
Expect: price 0.002 USDC, asset 10458941 (TestNet USDC), your address as
payTo, and `tag=x402-global-challenge`.

A real TestNet payment (optional, free test money):

1. Prepare two TestNet accounts, both opted in to USDC (asset 10458941): the
   payTo account, and a separate buyer account with TestNet ALGO
   (https://bank.testnet.algorand.network) and TestNet USDC
   (https://faucet.circle.com, choose Algorand Testnet).
2. Pay from `services/paywall`. The buyer's 25 words are read without being
   shown or saved; never paste them anywhere else or commit them.

   ```bash
   read -rsp "Buyer's 25 words: " AVM_MNEMONIC && export AVM_MNEMONIC && node scripts/pay.ts http://127.0.0.1:8080/v1/privacy/scan '{"text":"Patient Jane Roe, MRN 991122, was diagnosed with diabetes."}'
   ```
3. Verify it. The script's last line is
   `payment {"success":true,"transaction":"<TX ID>",...}`. The paywall prints a
   `payment_settled` line with the same ID (`docker logs ca-paywall` in step
   6). Open `https://lora.algokit.io/testnet/transaction/<TX ID>`: it shows
   0.002 USDC from the buyer to your payTo.

## 8. Configuration

All gateway flags: `node services/gateway/src/main.ts --help`.
Environment variables (names only in `.env.example`; never commit values):

| Variable | Used by | Meaning |
|---|---|---|
| `CHAINAIM_GATEWAY_KEY` | gateway, paywall | Shared key. The gateway requires it when started with `--api-key-env CHAINAIM_GATEWAY_KEY` (the production image is). |
| `OPENROUTER_API_KEY` | gateway | OpenRouter key for chat and Jev. Without it, chat is off and scan and mask still work. |
| `AVM_PAY_TO` | paywall | The Algorand address that receives payments. |
| `X402_NETWORK` | paywall | `testnet` (default) or `mainnet`. |
| `FACILITATOR_URL` | paywall | Default `https://facilitator.goplausible.xyz`. |
| `GATEWAY_URL` | paywall | Where the gateway is, e.g. `http://127.0.0.1:8700`. |
| `PUBLIC_BASE_URL` | paywall | The public `https://` address shown in 402 answers and the Bazaar (deployment only). |
| `PORT`, `HOST` | paywall | Default `8080` and `0.0.0.0`. |
| `GATEWAY_TIMEOUT_MS` | paywall | How long one call may take; default `200000`. |

## 9. Deploy

See `docs/deploy/railway.md`: three services on Railway's private network,
where only the paywall is public.

## 10. Troubleshooting

| What you see | What to do |
|---|---|
| `EADDRINUSE` | A port is in use. Stop the other process, or pick another port (`--port` for the gateway, `PORT` for the paywall). |
| `Presidio at ... did not answer within 120000 ms` | Presidio is not running or still loading. Start it first, or raise `--presidio-wait-ms`. |
| `does not support IN_AADHAAR, IN_PAN` | That is the stock Presidio image. Use the one built from `services/presidio`. |
| The gateway says Presidio did not detect some types at start-up | Presidio answers but misses the test sentence. Check `docker logs` and give it about 2 GB of memory. |
| `503` "the privacy scanner is unavailable" | Presidio is down. Nothing was sent anywhere and nothing is charged. |
| `401` from the gateway | Missing or wrong `authorization: Bearer <key>` (only when the gateway requires a key). |
| Chat `503` "chat is unavailable right now (no_models)" | The gateway has no OpenRouter key, or its free model list has not synced yet. |
| The paywall stops with "AVM_PAY_TO must be a 58-character Algorand address" | Set `AVM_PAY_TO` to a valid address. |
| `docker: ... name is already in use` | A container from an earlier run exists; remove it with `docker rm -f <name>`. |

## PowerShell instead of Git Bash

PowerShell sets environment variables first, then runs the command without
the prefix:

```powershell
$env:OR_DUMMY = "sk-or-dummy"
node services/gateway/src/main.ts --model-source openrouter-free --openrouter-base-url http://127.0.0.1:5003 --openrouter-key-env OR_DUMMY
```

For the `curl` examples and the payment step, Git Bash is easier: Windows
PowerShell changes the quotes inside the JSON bodies.
