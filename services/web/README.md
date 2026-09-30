# PrivacyBuddy web

A page for private chat: type a message, see it masked on your own device, then
Execute to pay (USDC, x402) and get the answer with your original values put back.
The buyer and pay-to wallets show top right.

Masking runs in the browser with `services/paywall/scripts/client-mask.ts`. The
server gets only masked text, re-checks it, pays the paywall's chat route from a
demo buyer wallet, and returns the answer and the payment receipt. It never logs
text, placeholders or the restore map.

## Run it on your PC

Start the paywall first (the test console's `start.cmd` does, at http://127.0.0.1:8080).

PowerShell, from the repository folder. The 25 words are typed at a hidden prompt and
only live in this window:

```powershell
$env:PAYWALL_URL = "http://127.0.0.1:8080"
$s = Read-Host "Buyer 25 words (TestNet demo wallet only)" -AsSecureString
$env:BUYER_MNEMONIC = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
npm --prefix services/web start
```

Open http://127.0.0.1:8740. Without `BUYER_MNEMONIC` the page still works up to
Execute, which then says the buyer wallet is not set up.

## Settings

| Variable | Meaning | Default |
|---|---|---|
| `PAYWALL_URL` | the paywall's address (required) | none |
| `BUYER_MNEMONIC` | the demo buyer's 25 words; only in the environment | not set |
| `PORT`, `HOST` | where to listen | `8740`, `127.0.0.1` |
| `RATE_PER_MINUTE` | executes per visitor per minute | `5` |
| `MAX_EXECUTES_PER_HOUR` | executes across all visitors per hour (bounds what the demo wallet can spend) | `30` |

## Safety

The buyer key is a hot wallet on a server: use a TestNet demo wallet only. Before any
MainNet use, replace it with wallet connect. The buyer also needs TestNet USDC
(https://faucet.circle.com) before Execute can pay.

## Tests

```bash
npm --prefix services/web test
```
