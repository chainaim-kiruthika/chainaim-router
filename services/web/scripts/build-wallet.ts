/**
 * Builds public/wallet.js, the browser bundle of src/wallet-entry.ts (Lute and
 * the x402 client). The bundle is committed so the server needs no build step;
 * its first line carries a hash of the sources, and test/wallet-bundle.test.ts
 * fails when the bundle is older than them. Run: npm run build:wallet
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
export const BUNDLE = new URL("public/wallet.js", root);
const SOURCES = ["src/wallet-entry.ts", "src/pay.ts", "src/lute-signer.ts", "src/balance.ts", "src/answer.ts", "src/buffer-shim.ts", "package-lock.json", "package.json", "scripts/build-wallet.ts"];

/** Line endings are normalised so a Windows checkout (autocrlf) hashes the same as Linux. */
export function sourceHash(): string {
  const h = createHash("sha256");
  for (const file of SOURCES) h.update(file + "\n" + readFileSync(new URL(file, root), "utf8").replace(/\r\n/g, "\n"));
  return h.digest("hex");
}

export async function buildWallet(): Promise<void> {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [fileURLToPath(new URL("src/wallet-entry.ts", root))],
    outfile: fileURLToPath(BUNDLE),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    inject: [fileURLToPath(new URL("src/buffer-shim.ts", root))],
    define: { global: "globalThis" },
    legalComments: "eof",
    banner: { js: `/* PrivacyBuddy wallet bundle, built by npm run build:wallet; source sha256 ${sourceHash()} */` },
    logLevel: "info",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildWallet();
