/**
 * Shared test helpers: corpus expectations, and a gateway on a loopback
 * port talking to the stub Presidio, with its own temporary ledger directory.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { loadCatalog } from "../src/catalog.ts";
import { Engine } from "../src/engine.ts";
import { Ledger } from "../src/ledger.ts";
import { Pool } from "../src/pool.ts";
import { CARD_REMOVED } from "../src/privacy/mask.ts";
import { PresidioClient } from "../src/privacy/presidio.ts";
import { createGateway } from "../src/server.ts";

/** A corpus text as restore gives it back: card numbers stay removed. */
export function withCardsRemoved(text: string): string {
  let out = text;
  for (const k of KNOWN_VALUES) if (k.type === "CREDIT_CARD") out = out.replaceAll(k.value, CARD_REMOVED);
  return out;
}

export type TestGateway = { url: string; server: Server; presidio: PresidioClient; ledgerDir: string; close: () => Promise<void> };

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
}

export async function startTestGateway(opts: { presidioUrl: string; gatewayKey?: string }): Promise<TestGateway> {
  const catalog = loadCatalog("config/catalog.json");
  const presidio = new PresidioClient({ url: opts.presidioUrl, threshold: 0.4, timeoutMs: 2000 });
  await presidio.checkHealth();
  const ledgerDir = mkdtempSync(join(tmpdir(), "chainaim-ledger-"));
  const pool = new Pool({ healthIntervalMs: 0, healthTimeoutMs: 1000, unhealthyAfter: 1, cooldownMs: 60_000, env: {} });
  pool.setModels(catalog.models);
  const server = createGateway(
    {
      engine: new Engine(catalog, { strategy: "rules", defaultProfile: "auto", defaultMaxTokens: 256 }),
      pool,
      ledger: new Ledger(ledgerDir),
      presidio,
    },
    { maxAttempts: 3, attemptTimeoutMs: 2000, maxBodyBytes: 1 << 20, gatewayKey: opts.gatewayKey },
  );
  const url = await listen(server);
  return { url, server, presidio, ledgerDir, close: () => closeServer(server) };
}

export const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Every ledger line written so far in `dir`, as raw text. */
export function ledgerText(dir: string): string {
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("");
}
