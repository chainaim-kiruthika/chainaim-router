/**
 * Shared test helpers: corpus expectations, and a gateway on a loopback port
 * wired like production (Presidio, pool, model source, scores, quota, Jev),
 * with stubs standing in for Presidio and OpenRouter.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN_VALUES } from "../../../scripts/synthetic-corpus.ts";
import { loadCatalog, type Catalog } from "../src/catalog.ts";
import { Ledger } from "../src/ledger.ts";
import { Pool } from "../src/pool.ts";
import { CARD_REMOVED } from "../src/privacy/mask.ts";
import { PresidioClient } from "../src/privacy/presidio.ts";
import { catalogSource, FreePool, openRouterDeployments, type ModelSource } from "../src/routing/freepool.ts";
import { JevClient } from "../src/routing/jev.ts";
import { Quota } from "../src/routing/quota.ts";
import { validateScoreTable, type ScoreTable } from "../src/routing/scores.ts";
import { ExpiringSet } from "../src/routing/select.ts";
import { createGateway } from "../src/server.ts";

/** A corpus text as restore gives it back: card numbers stay removed. */
export function withCardsRemoved(text: string): string {
  let out = text;
  for (const k of KNOWN_VALUES) if (k.type === "CREDIT_CARD") out = out.replaceAll(k.value, CARD_REMOVED);
  return out;
}

const jsonEscaped = (s: string): string => JSON.stringify(s).slice(1, -1);

/**
 * The corpus values found in `text`, raw or JSON-escaped. In serialized JSON
 * `Jane "JR" Roe` reads `Jane \"JR\" Roe`, and inside tool-call arguments
 * (JSON held in a JSON string) it is escaped twice, so all three forms count.
 */
export function leaked(text: string): string[] {
  return KNOWN_VALUES.map((k) => k.value).filter((v) => [v, jsonEscaped(v), jsonEscaped(jsonEscaped(v))].some((form) => text.includes(form)));
}

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

export const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Every ledger line written so far in `dir`, as raw text. */
export function ledgerText(dir: string): string {
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("");
}

/**
 * Scores that make the stub models' order predictable. For chat at
 * difficulty 1 (the stub Jev's default answer): bravo 7.5, alpha 7, charlie
 * 6.5. For a PHI request at difficulty 1, charlie's health domain puts it first.
 */
export const TEST_TABLE: ScoreTable = validateScoreTable({
  version: "test",
  weights: { qualityByDifficulty: [0.5, 0.75, 1.0, 1.25, 1.5], taskMatch: 2, domainMatch: 2, speedWhenEasy: { fast: 2, medium: 1, slow: 0 } },
  defaults: {
    qualityBySize: [[300, 8], [100, 7], [25, 6], [8, 5], [0, 3]],
    unknownSizeQuality: 5,
    speedBySize: [[100, "slow"], [25, "medium"], [0, "fast"]],
    unknownSizeSpeed: "medium",
  },
  models: {
    "stub/alpha-70b:free": { quality: 8, tasks: ["chat", "code", "reasoning", "tool_use"], speed: "medium", domains: [] },
    "stub/bravo-27b:free": { quality: 7, tasks: ["chat", "extraction"], speed: "fast", domains: [] },
    "stub/charlie-8b:free": { quality: 5, tasks: ["chat"], speed: "fast", domains: ["health"] },
    "local/small": { quality: 6, tasks: ["chat"], speed: "fast", domains: [] },
    "local/large": { quality: 5, tasks: ["chat"], speed: "medium", domains: [] },
  },
});

export type TestGatewayOptions = {
  presidioUrl: string;
  /** Use the stub OpenRouter at this URL (free pool, key, chat, Jev) instead of a catalog. */
  openRouterUrl?: string;
  /** Catalog mode (the default is config/catalog.json). */
  catalog?: Catalog;
  jev?: boolean;
  jevTimeoutMs?: number;
  rpm?: number;
  attemptTimeoutMs?: number;
  gatewayKey?: string;
};

export type TestGateway = {
  url: string;
  server: Server;
  presidio: PresidioClient;
  pool: Pool;
  quota: Quota;
  deny: ExpiringSet;
  ledgerDir: string;
  close: () => Promise<void>;
};

const OR_KEY_ENV = "OR_TEST_KEY";

export async function startTestGateway(o: TestGatewayOptions): Promise<TestGateway> {
  const presidio = new PresidioClient({ url: o.presidioUrl, threshold: 0.4, timeoutMs: 2000 });
  await presidio.checkHealth();
  const pool = new Pool({ healthIntervalMs: 0, healthTimeoutMs: 1000, unhealthyAfter: 1, cooldownMs: 60_000, env: { [OR_KEY_ENV]: "sk-or-test" } });
  let source: ModelSource;
  const orUrl = o.openRouterUrl;
  if (orUrl) {
    const free = new FreePool({ baseUrl: orUrl, intervalMs: 0, timeoutMs: 2000, onChange: (models) => pool.setModels(openRouterDeployments(models, orUrl, OR_KEY_ENV)) });
    await free.sync();
    source = free;
  } else {
    const catalog = o.catalog ?? loadCatalog("config/catalog.json");
    pool.setModels(catalog.models);
    source = catalogSource(catalog);
  }
  const quota = new Quota({ rpm: o.rpm ?? 1000, keyIntervalMs: 0, ...(orUrl ? { keyUrl: `${orUrl}/api/v1/key`, apiKey: "sk-or-test" } : {}) });
  await quota.refresh();
  const jev = orUrl && o.jev !== false ? new JevClient({ baseUrl: orUrl, apiKey: "sk-or-test", model: "typesafe/jev-1.13", timeoutMs: o.jevTimeoutMs ?? 1000 }) : undefined;
  const deny = new ExpiringSet(60_000);
  const ledgerDir = mkdtempSync(join(tmpdir(), "chainaim-ledger-"));
  const server = createGateway(
    {
      presidio,
      pool,
      source,
      table: TEST_TABLE,
      quota,
      deny,
      jev,
      ledger: new Ledger(ledgerDir),
      chat: { maxOutputTokens: 1024, maxAttempts: 3, attemptTimeoutMs: o.attemptTimeoutMs ?? 2000, healthFlagThreshold: 0.5 },
    },
    { maxBodyBytes: 1 << 20, gatewayKey: o.gatewayKey },
  );
  const url = await listen(server);
  return { url, server, presidio, pool, quota, deny, ledgerDir, close: () => closeServer(server) };
}
