# Start here: run ChainAim on your PC

This is the path from a fresh clone to the whole project running on your own
Windows PC. Each level builds on the one before it, and you can stop at any
level. Every example uses made-up data.

| Level | What you get | Needs |
|---|---|---|
| 1 | Tests pass | Git, Node.js |
| 2 | Gateway answering scan, mask and chat with stand-ins | Same |
| 3 | The full stack in Docker, plus the test console in your browser | Docker Desktop |
| 4 | Chat answered by real free models | An OpenRouter key |
| 5 | The PrivacyBuddy web page, paying per answer from your Lute wallet on TestNet | The Lute wallet extension |

The two detailed guides, if you get stuck or want the reasons behind a step:
[SETUP.md](SETUP.md) (tests, stand-ins, payments, configuration) and
[docs/setup-end-to-end.md](docs/setup-end-to-end.md) (Docker, OpenRouter, the
test console).

## How the project fits together

```
agent ──▶ paywall :8080 (public, x402) ──▶ gateway :8700 ──▶ OpenRouter free models (chat)
                                              └──▶ Presidio :5002 (finds personal data)
```

| Folder | What it is |
|---|---|
| `services/gateway` | Scan, mask and private chat. Plain TypeScript run by Node, no npm install |
| `services/paywall` | x402 payments in USDC on Algorand; the only public part |
| `services/presidio` | Our Presidio image (adds Indian IDs such as Aadhaar and PAN) |
| `services/web` | PrivacyBuddy, the demo web page |
| `test-console` | A local page at :8730 that drives the Docker stack |
| `scripts` | Stand-ins, smoke test and live checks |
| `packages/route-engine` | The routing engine, already built in `dist/` |
| `docs` | Design, decisions (`docs/adr`), deployment, blog |

Read [README.md](README.md) for the endpoints and prices and
[PROJECT_CONTEXT.md](PROJECT_CONTEXT.md) for the background.

## 0. Install the tools

- **Git**
- **Node.js 24** (22.22 or newer works)
- **Docker Desktop** (levels 3 to 5), with about 2 GB of memory free for Presidio
- **Git Bash**, which comes with Git for Windows

Check them:

```bash
node --version
```

```bash
docker version --format "{{.Server.Version}}"
```

The second one prints a version only while Docker Desktop is running.

**Which terminal:** use Git Bash for levels 1 and 2, and PowerShell for
levels 3 to 5. Git Bash rewrites some Docker paths and breaks the container
commands in level 3.

## 1. Clone, install, test

```bash
git clone https://github.com/chainaimdev/chainaim-router.git
```

```bash
cd chainaim-router
```

Install the three parts that have npm packages (the gateway has none):

```bash
npm --prefix services/paywall install
```

```bash
npm --prefix services/web install
```

```bash
npm --prefix packages/route-engine install
```

Run the tests. None of them use the internet.

```bash
npm test
```

```bash
npm run test:paywall
```

```bash
npm --prefix services/web test
```

```bash
npm run test:engine
```

If all four pass, your machine is set up correctly.

## 2. Run the gateway with stand-ins (no Docker, no keys)

Stand-ins replace Presidio and OpenRouter. Open three Git Bash windows in the
project folder.

Window 1, the stand-in scanner (port 5002):

```bash
npm run stub-presidio
```

Window 2, the stand-in models (port 5003), which answer `echo: <what they got>`:

```bash
npm run stub-openrouter
```

Window 3, the gateway (port 8700). `sk-or-dummy` is a made-up key only the
stand-in sees:

```bash
OR_DUMMY=sk-or-dummy node services/gateway/src/main.ts --model-source openrouter-free --openrouter-base-url http://127.0.0.1:5003 --openrouter-key-env OR_DUMMY
```

In a fourth window, run the smoke test. Expect `7 passed, 0 failed`.

```bash
node scripts/smoke.ts --chat
```

Try a mask yourself:

```bash
curl -s -X POST http://127.0.0.1:8700/v1/privacy/mask -H "content-type: application/json" -d '{"text":"Patient Jane Roe, MRN 991122, was diagnosed with diabetes."}'
```

The stand-in scanner only knows the made-up values in
`scripts/synthetic-corpus.ts` (Jane Roe, MRN 991122, the card
4111 1111 1111 1111 and so on). Real text needs the real scanner in level 3.

Stop all four windows with Ctrl+C before level 3, so the ports are free.

## 3. The full stack in Docker, with the test console

Use **PowerShell** in the project folder from here on. Start Docker Desktop
first.

### 3.1 Build the images

The first Presidio build takes a few minutes (about 1.6 GB).

```powershell
docker build -t chainaim-presidio:test services/presidio
```

```powershell
docker build -t chainaim-gateway:test -f services/gateway/Dockerfile .
```

```powershell
docker build -t chainaim-paywall:test services/paywall
```

### 3.2 Make the network and the local gateway key

```powershell
docker network create chainaim-test
```

The paywall and the console share a key with the gateway. It is saved in
`test-console/local-gateway-key.txt`, which git ignores. Run this **once
only**; running it again makes the key stop matching the gateway's.

```powershell
node -e "require('fs').writeFileSync('test-console/local-gateway-key.txt', require('crypto').randomBytes(24).toString('base64url'))"
```

### 3.3 Make a TestNet address for the paywall

The paywall needs an Algorand TestNet address to receive payments. Make one:

```powershell
node services/paywall/scripts/new-account.ts
```

It prints an address and 25 words. Keep the words in a password manager, never
in a file or a chat, then clear the terminal (`cls`). Only the address goes in
the next step.

### 3.4 Start Presidio, the stand-in and the paywall

```powershell
docker run -d --name ca-presidio --network chainaim-test --network-alias presidio.railway.internal chainaim-presidio:test
```

```powershell
docker run -d --name ca-openrouter-stub --network chainaim-test --network-alias openrouter-stub -p 127.0.0.1:5004:5004 -v "${PWD}\scripts:/app/scripts:ro" -v "${PWD}\test-console\spy:/spy:ro" node:24-slim node /spy/spy-openrouter.ts
```

```powershell
$env:CHAINAIM_GATEWAY_KEY = (Get-Content -Raw test-console\local-gateway-key.txt).Trim()
```

Replace `YOUR_TESTNET_ADDRESS` with the address from 3.3:

```powershell
docker run -d --name ca-paywall --network chainaim-test -e AVM_PAY_TO=YOUR_TESTNET_ADDRESS -e X402_NETWORK=testnet -e GATEWAY_URL=http://gateway.railway.internal:8700 -e CHAINAIM_GATEWAY_KEY -p 127.0.0.1:8080:8080 chainaim-paywall:test
```

### 3.5 Start the gateway

This script creates the `ca-gateway` container with the stand-in models,
waits for Presidio (up to a minute), and asks a test question:

```powershell
test-console\use-stand-in.cmd
```

Expect `Answer from ...: echo: ...`. Then check the whole chain; the paywall's
health check goes through the gateway to Presidio:

```powershell
curl.exe -s http://127.0.0.1:8080/healthz
```

Expect `{"status":"ok"}`.

### 3.6 Open the test console

```powershell
test-console\start.cmd
```

Open http://127.0.0.1:8730. Keep that window open; closing it stops the page,
not the containers.

| Section | Try this |
|---|---|
| 1. Scan and mask | `Patient Jane Roe, MRN 991122, was diagnosed with diabetes.` Expect a name, a record number and the class PHI |
| 2. Private chat | Ask something with a name in it; the answer comes back with the name restored |
| 3. Payment | An unpaid call through the paywall: expect 402 with the price and pay-to |
| 4. Decision ledger | What the gateway decided per request: classes, counts, models, never text |

Sample files to paste from are in `test-console/samples/`.

## 4. Real models (OpenRouter)

Scan and mask never call OpenRouter; only chat does. To turn real chat on:

1. Sign up at https://openrouter.ai (no card needed for free models).
2. In https://openrouter.ai/settings/privacy, turn on "Enable free endpoints
   that may train on inputs". Without it, OpenRouter finds no free model. The
   gateway masks personal data before any model sees it, and health data only
   goes to providers that don't collect data.
3. Create a key at https://openrouter.ai/keys with a small credit limit
   (for example $1). Name it something like `chainaim-<yourname>-local`.
   Copy it once and keep it in a password manager. Never put it in a file in
   the repo, a commit or a chat.
4. Switch the gateway to real models. It asks for the key at a hidden prompt:

   ```powershell
   test-console\use-real-models.cmd
   ```

   Expect `Answer from <some model>:free: The capital of India is New Delhi...`.

Free use is capped at 50 requests a day until the account has bought $10 of
credits (then 1,000 a day). To go back to the stand-in and remove the key from
the container:

```powershell
test-console\use-stand-in.cmd
```

Section 3 of [docs/setup-end-to-end.md](docs/setup-end-to-end.md) explains
these settings and how to check a key with `npm run verify:openrouter`.

## 5. PrivacyBuddy, the web page (optional)

The page masks a message in the browser, then pays the paywall's chat route
from **your own Lute wallet**, and shows the answer with the real values put
back. Nobody types the 25 words: Lute keeps them and asks you to approve each
payment. It needs the level 3 stack running, and real models from level 4 for
real answers.

1. Install the Lute extension in Chrome from https://lute.app and make or
   import a TestNet account in it. This is the buyer; don't use the paywall's
   pay-to account.
2. Fund it with TestNet ALGO at https://bank.testnet.algorand.network.
3. Opt it in to TestNet USDC (asset 10458941) and get TestNet USDC at
   https://faucet.circle.com (choose Algorand Testnet).

Then, in PowerShell from the project folder:

```powershell
$env:PAYWALL_URL = "http://127.0.0.1:8080"
npm --prefix services/web start
```

Open http://127.0.0.1:8740 and click **Connect Lute** (top right). Mask a
message, press Execute, and approve the 0.01 USDC payment in Lute. You can look
the transaction up at `https://lora.algokit.io/testnet/transaction/<TX ID>`.

The page as it was in the demo video (a demo wallet held by the server) is the
git tag `demo-video-v1`.

## Everyday use

| To | Run (PowerShell) |
|---|---|
| Start everything and the console after a reboot | `test-console\start.cmd` |
| Use real models | `test-console\use-real-models.cmd` |
| Back to the stand-in (removes the key) | `test-console\use-stand-in.cmd` |
| Stop the containers | `docker stop ca-paywall ca-gateway ca-openrouter-stub ca-presidio` |
| See what the gateway is doing | `docker logs ca-gateway` |
| See what the paywall is doing | `docker logs ca-paywall` |
| Rebuild after pulling code changes | Repeat 3.1, then `test-console\use-stand-in.cmd` (it recreates the gateway) |

After a paywall rebuild, remove and recreate its container:
`docker rm -f ca-paywall`, then the `docker run` line from 3.4.

## Troubleshooting

| What you see | What to do |
|---|---|
| `EADDRINUSE` | Something already uses the port. Close the old window or process. |
| `docker: ... name is already in use` | `docker rm -f <name>`, then run the command again. |
| The stand-in container exits at once | Run the Docker commands from PowerShell in the project folder, not Git Bash. |
| The console page shows errors right after start | Presidio is still loading. Wait a minute and reload. |
| Console crashes: missing `local-gateway-key.txt` | Do step 3.2. The file is not in git. |
| `401` from the gateway | The key file changed after the gateway was created. Run `test-console\use-stand-in.cmd` and recreate `ca-paywall` (3.4). |
| Chat `503` "no_models" | No OpenRouter key on the gateway, or the model list has not loaded yet. Check `docker logs ca-gateway`. |
| OpenRouter `404` "No endpoints found matching your data policy" | The privacy switch in level 4, step 2. |
| OpenRouter `429`, or chat stops mid-day | The free daily limit (50 a day under $10 of credits). |
| Paywall stops: "AVM_PAY_TO must be a 58-character Algorand address" | Use the address from 3.3, not the 25 words. |
| A health-data chat is refused and not charged | No free model has a provider that declines to collect data right now. That refusal is on purpose; try later. |

## Rules for working in this repo

- Never commit keys, 25-word mnemonics or `.env` files. Variable names live in
  `.env.example`, values never do.
- Use made-up data only (`scripts/synthetic-corpus.ts`), never real customer
  or patient text.
- Run `npm test` and `npm run test:paywall` before you push.
- Online deployment (Railway) is in [docs/deploy/railway.md](docs/deploy/railway.md).
  The live TestNet paywall is https://privacybuddy.up.railway.app.
