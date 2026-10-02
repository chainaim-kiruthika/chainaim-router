# Deploying the PrivacyBuddy page on Vercel

The PrivacyBuddy web page (`services/web`) runs on Vercel. The paywall,
gateway and Presidio stay on Railway (`docs/deploy/railway.md`), and the page
calls the live paywall at https://privacybuddy.up.railway.app.

```
browser ──▶ Vercel ── static: index.html, wallet.js, client-mask.js
                 └── functions /api/wallets, /api/chat ──▶ Railway paywall
```

The page needs no keys and holds none: each visitor pays from their own Lute
wallet in the browser. The only setting is `PAYWALL_URL`.

How it builds: `services/web/vercel.json` tells Vercel to run `npm ci` and
`npm run build:vercel`. That script (`scripts/build-vercel.ts`) writes
`.vercel/output` in Vercel's Build Output format, which Vercel deploys as it
is:

- the page, `wallet.js` and `client-mask.js` as static files;
- `/api/wallets` and `/api/chat` as Node functions with a 300-second limit (a
  paid answer can take up to 240 seconds);
- the same security headers (CSP and the rest) as the local server.

You don't need to set a framework, build command or output directory in
Vercel; `vercel.json` covers them.

## Before you start

- The code is on GitHub at https://github.com/chainaimdev/chainaim-router,
  branch `main`, including `services/web/vercel.json`.
- The Railway paywall answers. This should print `{"status":"ok"}`:

  ```bash
  curl -s https://privacybuddy.up.railway.app/healthz
  ```

- A Vercel account that can see the `chainaimdev` GitHub organisation. The
  first time, Vercel asks you to install its GitHub app on `chainaimdev` (or
  only on the `chainaim-router` repository). An organisation owner may have
  to approve it.

## 1. Import the repository

1. Go to https://vercel.com/new.
2. Under "Import Git Repository", choose `chainaimdev/chainaim-router` and
   click **Import**. If it isn't listed, use "Adjust GitHub App Permissions"
   to give Vercel access to the repository.

## 2. Configure the project

On the "Configure Project" screen:

1. **Project Name:** for example `privacybuddy`. The address becomes
   `https://<project-name>.vercel.app` (Vercel adds a suffix if the name is
   taken).
2. **Framework Preset:** `Other`.
3. **Root Directory:** click **Edit**, choose `services/web`, and confirm.
4. **Build and Output Settings:** leave them as they are; `vercel.json`
   overrides them.
5. **Environment Variables:** add one:

   | Key | Value |
   |---|---|
   | `PAYWALL_URL` | `https://privacybuddy.up.railway.app` |

   No trailing slash is needed (one is removed if present). There are no
   secrets to add.
6. Click **Deploy**. The build takes about a minute.

## 3. Check three project settings

Open the project, then **Settings**:

1. **Build and Deployment → Root Directory:** "Include files outside the root
   directory in the Build Step" must be **on** (it is by default). The page
   reuses the masking code in `services/paywall/scripts/client-mask.ts`, which
   is outside `services/web`.
2. **Build and Deployment → Node.js Version:** `22.x` or newer. The build
   script runs TypeScript directly with Node.
3. **Functions → Fluid Compute:** **on** (the default for new projects). It
   lets a function run up to 300 seconds, which a slow paid answer needs.

If you change any of these, redeploy: **Deployments**, the latest one, then
**⋯ → Redeploy**.

## 4. Check the deployment

Replace `privacybuddy.vercel.app` with your project's address.

1. The settings come from the Railway paywall. Expect `"network":"testnet"`,
   the pay-to address and `"prices":{"chat":0.01}`:

   ```bash
   curl -s https://privacybuddy.vercel.app/api/wallets
   ```

2. The relay refuses unmasked text without contacting the paywall. Expect
   HTTP 400 and "still holds values that should be masked":

   ```bash
   curl -s -X POST https://privacybuddy.vercel.app/api/chat -H "content-type: application/json" -d '{"model":"chainaim/auto","messages":[{"role":"user","content":"Email priya.raman@example.com"}]}'
   ```

3. In Chrome with the Lute extension and a funded TestNet account:
   1. Open the address. The top right shows **Buyer: Connect Lute** and the
      Pay to chip.
   2. Click **Connect Lute** and choose the TestNet account. The chip shows
      its address and USDC balance.
   3. Press **Try an example**, then **Execute**, and approve 0.01 USDC in
      Lute.
   4. The answer appears with your values put back, and "Paid 0.01 USDC ·
      receipt". Open the receipt on lora to see the payment.

## 5. After the first deploy

- Every push to `main` on chainaimdev redeploys automatically. Pull requests
  get their own preview addresses.
- Changing `PAYWALL_URL` takes effect only after a redeploy.
- A custom domain can be added under **Settings → Domains**.
- Logs: **Deployments → (a deployment) → Logs**, or the **Logs** tab. The
  functions log status, sizes and timing only, never text or payments.

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| `/api/wallets` answers 500 "This deployment is not configured: PAYWALL_URL ..." | `PAYWALL_URL` is missing or not an `http(s)` address. Set it (step 2.5) and redeploy. |
| `/api/wallets` shows `"network":"unknown"` and no pay-to | The Railway paywall didn't answer. Check `curl -s https://privacybuddy.up.railway.app/healthz`. |
| The build fails with "Cannot find module ... paywall/scripts/client-mask.ts" | "Include files outside the root directory" is off (step 3.1). |
| The build fails with a syntax error in a `.ts` file | The Node.js version is older than 22 (step 3.2). |
| The build fails on `maxDuration` | Fluid Compute is off (step 3.3), or the plan doesn't allow 300 seconds. |
| A paid answer fails after about 5 minutes | The model took too long. The page says to check your wallet's recent transactions before trying again. |
| The page loads but Execute says Lute could not open | Install the Lute extension (https://lute.app), or allow pop-ups for the Vercel address. |
| 404 at `/` | The Root Directory isn't `services/web` (step 2.3). |

## Building locally

The same build runs on your PC without a Vercel account:

```bash
npm --prefix services/web run build:vercel
```

It writes `services/web/.vercel/output` (git ignores it). The test
`services/web/test/vercel-build.test.ts` builds it into a temporary folder and
runs the built function against a stand-in paywall.
