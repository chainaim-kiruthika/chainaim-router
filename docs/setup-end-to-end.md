# ChainAim setup, start to finish

This guide takes you from an empty Windows PC to the full ChainAim stack
running in Docker, answering private chat through OpenRouter's free models,
with the test console open in your browser. It covers the OpenRouter account
and API key in detail, because chat does not work without them.

Two other guides cover parts of this: `SETUP.md` (tests, stand-ins, and the
same containers with different names) and `docs/deploy/railway.md` (the
online deployment). This one is the path for a single PC, using the test
console in `test-console/`.

Commands are for **PowerShell**, run from the repository folder, one at a time.

## What you end up with

| Part | Container | Where you reach it | What it is |
|---|---|---|---|
| Presidio | `ca-presidio` | private only | Finds personal, health and card data |
| Stand-in OpenRouter | `ca-openrouter-stub` | http://127.0.0.1:5004 | Fake models that echo, and a record of what was sent to them |
| Gateway | `ca-gateway` | http://127.0.0.1:8720 | Scan, mask and private chat (needs a key) |
| Paywall | `ca-paywall` | http://127.0.0.1:8080 | The public x402 front: answers 402 until paid |
| Test console | none (a Node process) | http://127.0.0.1:8730 | One web page that drives all of the above |

All four containers share the Docker network `chainaim-test`. The gateway
talks to Presidio as `presidio.railway.internal` and the paywall talks to the
gateway as `gateway.railway.internal`, the same names Railway uses.

The gateway has two modes. In **stand-in** mode its models are the fake ones
in `ca-openrouter-stub`: free, offline, and good for checking the plumbing.
In **real** mode it calls OpenRouter with your key.

## 1. What you need

- Git, and Node.js 24 (22.22 or newer works)
- Docker Desktop, running, with about 2 GB of memory free for Presidio
- Free ports 5004, 8080, 8720 and 8730
- An email address for the OpenRouter account
- An Algorand TestNet address for the paywall's `AVM_PAY_TO` (step 6)

```powershell
node --version
```

```powershell
docker version --format "{{.Server.Version}}"
```

The second command prints a version only when Docker Desktop is running.

## 2. Get the code

```powershell
git clone https://github.com/chainaimdev/chainaim-router.git
```

```powershell
cd chainaim-router
```

```powershell
npm --prefix services/paywall install
```

The gateway needs no packages. The paywall needs its own install for the
`pay.ts` payment script; the paywall image installs its own copy.

Optional check that the code is healthy (about 5 seconds each):

```powershell
npm test
```

```powershell
npm run test:paywall
```

## 3. Set up OpenRouter

The gateway sends chat to OpenRouter's free models and uses OpenRouter's
Decisions API (the Jev classifier) with the same key. Scan and mask never
call OpenRouter, so you can skip this step and still use those two. Chat
will report that it is unavailable until a key is set.

### 3.1 Create an account

Sign up at https://openrouter.ai. Free models do not need a card.

### 3.2 Decide about credits

OpenRouter limits free-model use by how much you have ever bought:

| Credits bought | Requests a minute | Requests a day |
|---|---|---|
| under $10 | 20 | 50 |
| $10 or more | 20 | 1,000 |

Fifty a day is enough to try the console; it is not enough for a live
service or for `npm run verify:openrouter` plus real use on the same day. To
lift the daily cap, buy $10 of credits at https://openrouter.ai/settings/credits.
The gateway only calls free models, so the credits are not spent on them.
Keep the balance above zero: OpenRouter answers "402 Payment Required" on
free models too when the balance is negative.

### 3.3 Check the privacy settings

Open https://openrouter.ai/settings/privacy. OpenRouter has separate switches
for free endpoints that may train on your inputs and free endpoints that may
publish prompts. Many free models run on providers that log or train, so with
these switched off, OpenRouter answers `404 No endpoints found matching your
data policy` for them and the gateway finds no model to use.

Turn on "Enable free endpoints that may train on inputs". If chat still
finds no model, look at the other free-endpoint switch on the same page. The
switch names are OpenRouter's and may change; go by what the page says.

This is a real trade-off, so know what it means. ChainAim masks names, numbers
and other personal data before any model sees the text, so a free provider
that keeps prompts keeps masked text. Text classed as health data is different:
the gateway sends it only with `provider.data_collection: deny`, which limits it
to providers that do not collect data, and refuses (without charge) when none is
available. That per-request rule holds whatever the account switches say.

### 3.4 Create the key

1. Open https://openrouter.ai/keys and choose to create a key.
2. Name it after where it will live, for example `chainaim-gateway-local`.
3. Set a small credit limit, such as $1, as a safety net.
4. Copy the key when it is shown. OpenRouter shows it once.

Keep the key in a password manager. Do not put it in a file in this
repository, in a chat, in a commit or in a shell history. `.env` files are
already ignored by git, but the safest place is nowhere on disk: the steps
below type it into a hidden prompt.

If a key is ever exposed, delete it on the keys page and make a new one.

### 3.5 Check the key against OpenRouter

This runs `scripts/verify-openrouter.ts` with your key in this PowerShell
window only. Paste the key at the hidden prompt:

```powershell
$secure = Read-Host "OpenRouter API key" -AsSecureString
```

```powershell
$env:OPENROUTER_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
```

```powershell
npm run verify:openrouter
```

It prints three checks and sends only short made-up text:

- V1: one Jev call. Expect `HTTP 200` and `parseJevAnswers` printing answers, not `REJECTED`.
- V2: your key's allowance. Expect `free_model_daily_requests` with a limit of 50 or 1000.
- V5: one call per free model with the no-collection setting. Some models will fail here. That is expected: it shows which free models can take health data right now.

The run makes one call per free model, so with under $10 of credits it uses
a good part of the day's 50. Clear the key from this window when you are done:

```powershell
Remove-Item Env:OPENROUTER_API_KEY
```

If V1 says `401`, the key is wrong or was deleted. If it says `402`, see
section 3.2. If it says `404` or `no endpoints`, see section 3.3.

## 4. Build the three images

Still in the repository folder. Presidio is about 1.6 GB and the first build
takes a few minutes. The tag `:test` is what the test-console scripts expect.

```powershell
docker build -t chainaim-presidio:test services/presidio
```

```powershell
docker build -t chainaim-gateway:test -f services/gateway/Dockerfile .
```

```powershell
docker build -t chainaim-paywall:test services/paywall
```

The gateway build uses the repository root as its context, so run it from
the repository folder. The route engine it needs is already built and
committed in `packages/route-engine/dist`.

## 5. Make the network and the local gateway key

```powershell
docker network create chainaim-test
```

The console and the paywall talk to the gateway with a shared key that stays
on this PC. Make it once; the console reads it from `test-console/`, where git
ignores it:

```powershell
node -e "require('fs').writeFileSync('test-console/local-gateway-key.txt', require('crypto').randomBytes(24).toString('base64url'))"
```

Do not run that command again once the gateway exists, or the key in the file
stops matching the one the gateway was started with.

## 6. Start Presidio, the stand-in and the paywall

```powershell
docker run -d --name ca-presidio --network chainaim-test --network-alias presidio.railway.internal chainaim-presidio:test
```

The stand-in mounts the repository's `scripts` folder and the console's `spy`
folder. It needs to exist even if you only use real models, because the
console and `start.cmd` expect it:

```powershell
docker run -d --name ca-openrouter-stub --network chainaim-test --network-alias openrouter-stub -p 127.0.0.1:5004:5004 -v "${PWD}\scripts:/app/scripts:ro" -v "${PWD}\test-console\spy:/spy:ro" node:24-slim node /spy/spy-openrouter.ts
```

Run the Docker commands in PowerShell, not Git Bash: Git Bash rewrites the
`/spy/...` argument into a Windows path and the container fails to start.

For the paywall you need a TestNet address, 58 capital letters and digits,
of an account you control. To make a new one:

```powershell
cd services/paywall
```

```powershell
node scripts/new-account.ts
```

```powershell
cd ../..
```

It prints an address and 25 words. Save the words in a password manager and
clear the terminal; only the address goes into the next command. Use a
separate account as the buyer when you make a real TestNet payment.

```powershell
$env:CHAINAIM_GATEWAY_KEY = (Get-Content -Raw test-console\local-gateway-key.txt).Trim()
```

```powershell
docker run -d --name ca-paywall --network chainaim-test -e AVM_PAY_TO=YOUR_TESTNET_ADDRESS -e X402_NETWORK=testnet -e GATEWAY_URL=http://gateway.railway.internal:8700 -e CHAINAIM_GATEWAY_KEY -p 127.0.0.1:8080:8080 chainaim-paywall:test
```

The paywall does not need the gateway to start, but it has nothing to forward
to until you make the gateway in the next step.

## 7. Start the gateway

The gateway container is made by the switch scripts in `test-console/`.
Presidio needs up to a minute to load, and the script waits for it.

For your first run, start in stand-in mode so you can check everything
without OpenRouter:

```powershell
test-console\use-stand-in.cmd
```

It recreates `ca-gateway`, waits until it is healthy, then asks the stand-in
"What is the capital of India?" and prints the answer. Expect
`Answer from ...: echo: ...` and `The stand-in model is back on.` Press a key
when it says so; the script waits before it closes.

Check the gateway and the paywall from the outside:

```powershell
curl.exe -s http://127.0.0.1:8720/healthz
```

```powershell
curl.exe -s http://127.0.0.1:8080/healthz
```

The paywall's check goes through to the gateway, which checks Presidio, so
`{"status":"ok"}` from the second command means all three are up.

## 8. Switch to real models

Now put your OpenRouter key on the gateway:

```powershell
test-console\use-real-models.cmd
```

It asks for the key in a hidden prompt (or uses `OPENROUTER_API_KEY` if that is
already set in the window), recreates `ca-gateway` with the key, and asks the
same question through OpenRouter. Expect:

```
Answer from <a free model id ending in :free>: The capital of India is New Delhi...
Real models are on. Ask in the console at http://127.0.0.1:8730/ (section 2).
```

Which real answer you get varies. The gateway loads the current list of free
models at start-up, tries them in order of score, and retries on failure.

The key is never written to a file. While real mode is on, Docker holds it in
the `ca-gateway` container's settings on this PC, so anyone who can run
`docker inspect` on this machine can read it. Switch back to the stand-in
(`test-console\use-stand-in.cmd`) to remove it, and delete the key on the
OpenRouter keys page if you are done with it for good.

If the test question fails, the script prints why and suggests going back to
the stand-in. Section 11 lists the usual causes.

## 9. Open the test console

```powershell
test-console\start.cmd
```

This starts the four containers if they are stopped, waits for the gateway,
then serves the console at http://127.0.0.1:8730. Keep that window open;
closing it stops the console, not the containers.

| Section | What it does |
|---|---|
| 1. Scan and mask | Sends your text to the gateway and shows what it found and what it would replace |
| 2. Private chat | Sends a chat message; the answer comes back with your original values restored |
| 3. Payment | Sends an unpaid call through the paywall and shows the 402 with its price, network and pay-to |
| 4. Decision ledger | Shows the last lines the gateway wrote about its routing decisions |

Things to try, all with made-up data:

- Section 1: `Patient Jane Roe, MRN 991122, was diagnosed with diabetes.` Expect names, a record number and a health term, and the class PHI.
- Section 2: ask something with a name in it. In real mode the answer comes from a free model that never saw the name.
- Section 3: expect 402 and a price of 0.002, 0.003 or 0.01 USDC.

In real mode the two panels that show what left ChainAim, and what Jev
received, stay empty: they read the stand-in, which real mode does not use.
The decision ledger still records every request, with classes, counts and model
names, and never the text.

## 10. Everyday use

After a PC or Docker restart the containers stay stopped, because none has a
restart policy. Run `test-console\start.cmd` again.

| To | Run |
|---|---|
| Start everything and the console | `test-console\start.cmd` |
| Use real models | `test-console\use-real-models.cmd` |
| Go back to the stand-in and remove the key | `test-console\use-stand-in.cmd` |
| Stop the containers | `docker stop ca-paywall ca-gateway ca-openrouter-stub ca-presidio` |
| See what the gateway is doing | `docker logs ca-gateway` |
| Tell which mode the gateway is in | `docker inspect ca-gateway --format "{{range .Config.Env}}{{println .}}{{end}}"` shows the variable names; `OPENROUTER_API_KEY` means real, `OR_DUMMY` means stand-in |

Do not print the values from that last command; they include the key.

The decision ledger lives in the Docker volume `chainaim-test-ledger`, so it
survives switching modes. Remove it with `docker volume rm chainaim-test-ledger`
after removing the gateway container.

## 11. Troubleshooting

| What you see | Cause and fix |
|---|---|
| `start.cmd` says Docker could not start the test containers | Docker Desktop is not running, or a container was never created. Run section 6 for the missing one. |
| The page shows errors right after start | The gateway is still loading Presidio. Wait a minute and reload. |
| Chat answers `503`, "chat is unavailable right now (no_models)" | No OpenRouter key on the gateway (section 8), or the free model list has not loaded yet. Check `docker logs ca-gateway`. |
| Real mode test question fails with `401` | The key is wrong, deleted or mistyped. Make a new one (section 3.4). |
| `402` from OpenRouter | The account balance is negative (section 3.2). |
| `404` "No endpoints found matching your data policy" | The account's privacy switches block every free endpoint (section 3.3). |
| `429`, or chat stops working partway through the day | The free limit: 20 a minute, and 50 a day until you have bought $10 of credits. |
| A chat with health data is refused, and not charged | No free model has a provider that declines to collect data right now. The gateway refuses rather than send health text to one that collects. Try again later, or check the ledger, which counts these. |
| `docker: ... name is already in use` | An old container exists. Remove it with `docker rm -f <name>` and run the command again. |
| The stand-in container exits at once | The mount paths did not resolve. Run the command from PowerShell in the repository folder. |
| The console crashes with a missing `local-gateway-key.txt` | Do section 5. The key file is not in git. |
| `EADDRINUSE` starting the console | Another program uses port 8730. Close the old console window first. |

## 12. Going online

For Railway, follow `docs/deploy/railway.md`. To turn chat on there, add
your OpenRouter key as `OPENROUTER_API_KEY` on the gateway service only, redeploy
it, and run `npm run verify:openrouter` from your PC with the same key. Use
a separate OpenRouter key for the deployment from the one on your PC, with its
own name and credit limit, so you can delete one without breaking the other.
Buy the $10 of credits first: fifty requests a day will not last.
