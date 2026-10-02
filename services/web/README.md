# PrivacyBuddy web

A page for private chat: type a message, see it masked on your own device, then
Execute to pay (USDC, x402) from your own Lute wallet and get the answer with
your original values put back. The buyer (your Lute account) and the pay-to
wallet show top right.

Masking runs in the browser with `services/paywall/scripts/client-mask.ts`.
Paying runs in the browser too: `public/wallet.js` holds the x402 client and
`@galaxypay/lute-connect`, and Lute signs each payment after you approve it. The server
holds no wallet key. It relays the paid call to the paywall (`POST /api/chat`)
after checking the text has nothing left to mask, and never logs text,
placeholders, the restore map or the payment.

## Run it on your PC

1. Start the paywall first (the test console's `start.cmd` does, at
   http://127.0.0.1:8080).
2. Install the Lute extension in Chrome from https://lute.app, and make or
   import a TestNet account in it. Without the extension, Lute opens as a
   pop-up from lute.app instead.
3. Give that account TestNet ALGO (https://bank.testnet.algorand.network),
   opt it in to USDC (asset 10458941), and get TestNet USDC
   (https://faucet.circle.com, choose Algorand Testnet).
4. Start the page (PowerShell, from the repository folder):

   ```powershell
   $env:PAYWALL_URL = "http://127.0.0.1:8080"
   npm --prefix services/web start
   ```

Open http://127.0.0.1:8740, click **Connect Lute**, then Mask and Execute.
Lute asks you to approve each payment.

## Settings

| Variable | Meaning | Default |
|---|---|---|
| `PAYWALL_URL` | the paywall's address (required) | none |
| `PORT`, `HOST` | where to listen | `8740`, `127.0.0.1` |

## The browser bundle

`public/wallet.js` is built from `src/wallet-entry.ts` and committed. After
changing `src/wallet-entry.ts`, `src/lute-signer.ts`, `src/balance.ts`,
`src/answer.ts`, `src/buffer-shim.ts`, `scripts/build-wallet.ts`, `package.json` or `package-lock.json`, rebuild it:

```bash
npm --prefix services/web run build:wallet
```

A test fails if the bundle is older than its sources.

## Tests

```bash
npm --prefix services/web test
```

The version of this page shown in the demo video (server-held demo wallet) is
the git tag `demo-video-v1`.
