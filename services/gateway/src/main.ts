/**
 * chainaim-gateway: entry point.
 *
 *   node services/gateway/src/main.ts [flags]
 *
 * Every behaviour is a flag with a default; nothing is hard-coded elsewhere.
 */
import { parseArgs } from "node:util";
import { loadCatalog } from "./catalog.ts";
import { Ledger } from "./ledger.ts";
import { Pool } from "./pool.ts";
import { PresidioClient, waitForPresidio } from "./privacy/presidio.ts";
import { catalogSource, FreePool, openRouterDeployments, type ModelSource } from "./routing/freepool.ts";
import { JevClient } from "./routing/jev.ts";
import { Quota } from "./routing/quota.ts";
import { loadScoreTable } from "./routing/scores.ts";
import { ExpiringSet } from "./routing/select.ts";
import { createGateway } from "./server.ts";

const USAGE = `chainaim-gateway [flags]

  --model-source catalog|openrouter-free  chat models: catalog (tests, local) or OpenRouter free (default catalog)
  --catalog PATH             model catalog JSON, catalog mode            (default config/catalog.json)
  --scores PATH              free-model scoring table                    (default config/free-models.json)
  --host HOST                bind address                                (default 127.0.0.1)
  --port N                   listen port                                 (default 8700)
  --max-output-tokens N      cap and default for max_tokens              (default 1024)
  --max-attempts N           model attempts per chat request             (default 3)
  --attempt-timeout-ms N     one model attempt, whole answer             (default 60000)
  --health-interval-ms N     catalog deployment probe period, 0 = off    (default 10000)
  --health-timeout-ms N      per-probe timeout                           (default 3000)
  --unhealthy-after N        consecutive failures before cooldown        (default 2)
  --cooldown-ms N            how long a failed deployment sits out       (default 30000)
  --presidio-url URL         Presidio analyzer                           (default http://127.0.0.1:5002)
  --presidio-threshold N     minimum entity score, 0 to 1                (default 0.4)
  --presidio-timeout-ms N    per Presidio call                           (default 10000)
  --presidio-wait-ms N       how long start-up waits for Presidio        (default 120000)
  --presidio-check-ms N      Presidio health check period                (default 30000)
  --openrouter-base-url URL  OpenRouter API root                         (default https://openrouter.ai)
  --openrouter-key-env NAME  env var holding the OpenRouter key          (default OPENROUTER_API_KEY)
  --jev on|off               classify chat requests with Jev             (default on)
  --jev-model ID             Decisions API model                         (default typesafe/jev-1.13)
  --jev-timeout-ms N         Jev call timeout                            (default 800)
  --health-flag-threshold N  Jev health probability that makes PHI       (default 0.5)
  --free-sync-interval-ms N  free model list refresh                     (default 21600000)
  --free-rpm N               free-model calls per 60 s window            (default 20)
  --deny-cache-ms N          skip a model with no no-collection provider (default 21600000)
  --key-read-interval-ms N   OpenRouter key allowance read period        (default 600000)
  --ledger DIR|off           decision ledger directory                   (default data/ledger)
  --max-body-bytes N         request size limit                          (default 4194304)
  --api-key-env NAME         env var holding the gateway bearer key      (default none = no auth)
  --help`;

function int(name: string, value: string, min: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}, got ${value}`);
  return n;
}

function num(name: string, value: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be a number from ${min} to ${max}, got ${value}`);
  return n;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

const OPTIONS = {
  "model-source": { type: "string", default: "catalog" },
  catalog: { type: "string", default: "config/catalog.json" },
  scores: { type: "string", default: "config/free-models.json" },
  host: { type: "string", default: "127.0.0.1" },
  port: { type: "string", default: "8700" },
  "max-output-tokens": { type: "string", default: "1024" },
  "max-attempts": { type: "string", default: "3" },
  "attempt-timeout-ms": { type: "string", default: "60000" },
  "health-interval-ms": { type: "string", default: "10000" },
  "health-timeout-ms": { type: "string", default: "3000" },
  "unhealthy-after": { type: "string", default: "2" },
  "cooldown-ms": { type: "string", default: "30000" },
  "presidio-url": { type: "string", default: "http://127.0.0.1:5002" },
  "presidio-threshold": { type: "string", default: "0.4" },
  "presidio-timeout-ms": { type: "string", default: "10000" },
  "presidio-wait-ms": { type: "string", default: "120000" },
  "presidio-check-ms": { type: "string", default: "30000" },
  "openrouter-base-url": { type: "string", default: "https://openrouter.ai" },
  "openrouter-key-env": { type: "string", default: "OPENROUTER_API_KEY" },
  jev: { type: "string", default: "on" },
  "jev-model": { type: "string", default: "typesafe/jev-1.13" },
  "jev-timeout-ms": { type: "string", default: "800" },
  "health-flag-threshold": { type: "string", default: "0.5" },
  "free-sync-interval-ms": { type: "string", default: "21600000" },
  "free-rpm": { type: "string", default: "20" },
  "deny-cache-ms": { type: "string", default: "21600000" },
  "key-read-interval-ms": { type: "string", default: "600000" },
  ledger: { type: "string", default: "data/ledger" },
  "max-body-bytes": { type: "string", default: String(4 * 1024 * 1024) },
  "api-key-env": { type: "string" },
  help: { type: "boolean", default: false },
} as const;

export function parseFlags(argv: string[]) {
  const { values: v } = parseArgs({ args: argv, strict: true, options: OPTIONS });
  const source = v["model-source"]!;
  if (source !== "catalog" && source !== "openrouter-free") throw new Error("--model-source must be catalog or openrouter-free");
  if (v.jev !== "on" && v.jev !== "off") throw new Error("--jev must be on or off");
  if (!ENV_NAME.test(v["openrouter-key-env"]!)) throw new Error("--openrouter-key-env must be an environment variable NAME, not a key");
  for (const name of ["presidio-url", "openrouter-base-url"] as const) {
    if (!URL.canParse(v[name]!)) throw new Error(`--${name} must be a URL`);
  }
  return {
    help: v.help!,
    modelSource: source as "catalog" | "openrouter-free",
    catalog: v.catalog!,
    scores: v.scores!,
    host: v.host!,
    port: int("port", v.port!, 0),
    maxOutputTokens: int("max-output-tokens", v["max-output-tokens"]!, 1),
    maxAttempts: int("max-attempts", v["max-attempts"]!, 1),
    attemptTimeoutMs: int("attempt-timeout-ms", v["attempt-timeout-ms"]!, 1),
    healthIntervalMs: int("health-interval-ms", v["health-interval-ms"]!, 0),
    healthTimeoutMs: int("health-timeout-ms", v["health-timeout-ms"]!, 1),
    unhealthyAfter: int("unhealthy-after", v["unhealthy-after"]!, 1),
    cooldownMs: int("cooldown-ms", v["cooldown-ms"]!, 0),
    presidioUrl: v["presidio-url"]!,
    presidioThreshold: num("presidio-threshold", v["presidio-threshold"]!, 0, 1),
    presidioTimeoutMs: int("presidio-timeout-ms", v["presidio-timeout-ms"]!, 1),
    presidioWaitMs: int("presidio-wait-ms", v["presidio-wait-ms"]!, 0),
    presidioCheckMs: int("presidio-check-ms", v["presidio-check-ms"]!, 0),
    openRouterBaseUrl: v["openrouter-base-url"]!.replace(/\/+$/, ""),
    openRouterKeyEnv: v["openrouter-key-env"]!,
    jev: v.jev === "on",
    jevModel: v["jev-model"]!,
    jevTimeoutMs: int("jev-timeout-ms", v["jev-timeout-ms"]!, 1),
    healthFlagThreshold: num("health-flag-threshold", v["health-flag-threshold"]!, 0, 1),
    freeSyncIntervalMs: int("free-sync-interval-ms", v["free-sync-interval-ms"]!, 0),
    freeRpm: int("free-rpm", v["free-rpm"]!, 1),
    denyCacheMs: int("deny-cache-ms", v["deny-cache-ms"]!, 0),
    keyReadIntervalMs: int("key-read-interval-ms", v["key-read-interval-ms"]!, 0),
    ledgerDir: v.ledger === "off" ? undefined : v.ledger!,
    maxBodyBytes: int("max-body-bytes", v["max-body-bytes"]!, 1024),
    apiKeyEnv: v["api-key-env"],
  };
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  if (f.help) {
    console.log(USAGE);
    return;
  }
  const gatewayKey = f.apiKeyEnv ? process.env[f.apiKeyEnv] : undefined;
  if (f.apiKeyEnv && !gatewayKey) throw new Error(`--api-key-env ${f.apiKeyEnv} is set but the variable is empty`);
  if (!gatewayKey && f.host !== "127.0.0.1" && f.host !== "::1" && f.host !== "localhost") {
    throw new Error("refusing to listen on a non-loopback address without --api-key-env");
  }
  const openRouterKey = process.env[f.openRouterKeyEnv] || undefined;

  // Refuse to start without a Presidio that detects every required entity (V4).
  const presidio = new PresidioClient({ url: f.presidioUrl, threshold: f.presidioThreshold, timeoutMs: f.presidioTimeoutMs });
  await waitForPresidio(presidio, f.presidioWaitMs);
  presidio.start(f.presidioCheckMs);

  const table = loadScoreTable(f.scores);
  const pool = new Pool({ healthIntervalMs: f.healthIntervalMs, healthTimeoutMs: f.healthTimeoutMs, unhealthyAfter: f.unhealthyAfter, cooldownMs: f.cooldownMs, env: process.env });
  let source: ModelSource;
  let freePool: FreePool | undefined;
  if (f.modelSource === "catalog") {
    const catalog = loadCatalog(f.catalog);
    pool.setModels(catalog.models);
    source = catalogSource(catalog);
    await pool.checkAll();
    pool.start();
  } else if (!openRouterKey) {
    // Scan and mask never need OpenRouter, so a missing key must not take them down (spec section 13).
    console.error(`[chainaim-gateway] ${f.openRouterKeyEnv} is not set: chat is unavailable; scan and mask work`);
    source = { models: () => [], ready: () => false };
  } else {
    freePool = new FreePool({
      baseUrl: f.openRouterBaseUrl,
      intervalMs: f.freeSyncIntervalMs,
      timeoutMs: 15_000,
      onChange: (models) => pool.setModels(openRouterDeployments(models, f.openRouterBaseUrl, f.openRouterKeyEnv)),
    });
    if (!(await freePool.sync())) console.error("[chainaim-gateway] the free model sync failed; chat has no capacity until one succeeds");
    freePool.start();
    source = freePool;
  }
  const keyReader = f.modelSource === "openrouter-free" && openRouterKey ? { keyUrl: `${f.openRouterBaseUrl}/api/v1/key`, apiKey: openRouterKey } : {};
  const quota = new Quota({ rpm: f.freeRpm, keyIntervalMs: f.keyReadIntervalMs, ...keyReader });
  await quota.refresh();
  quota.start();
  const jev = f.jev && openRouterKey ? new JevClient({ baseUrl: f.openRouterBaseUrl, apiKey: openRouterKey, model: f.jevModel, timeoutMs: f.jevTimeoutMs }) : undefined;
  const ledger = new Ledger(f.ledgerDir);

  const server = createGateway(
    {
      presidio,
      pool,
      source,
      table,
      quota,
      deny: new ExpiringSet(f.denyCacheMs),
      jev,
      ledger,
      chat: { maxOutputTokens: f.maxOutputTokens, maxAttempts: f.maxAttempts, attemptTimeoutMs: f.attemptTimeoutMs, healthFlagThreshold: f.healthFlagThreshold },
    },
    { maxBodyBytes: f.maxBodyBytes, gatewayKey },
  );
  server.listen(f.port, f.host, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : f.port;
    console.log(
      `[chainaim-gateway] listening on http://${f.host}:${port}  source=${f.modelSource} models=${source.models().length} ` +
        `jev=${jev ? "on" : "off"} presidio=${presidio.url} ledger=${ledger.enabled ? f.ledgerDir : "off"} auth=${gatewayKey ? "on" : "off"}`,
    );
  });
  const shutdown = () => {
    pool.stop();
    freePool?.stop();
    quota.stop();
    presidio.stop();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main ?? process.argv[1]?.endsWith("main.ts")) {
  main().catch((e) => {
    console.error(`[chainaim-gateway] ${(e as Error).message}`);
    process.exit(1);
  });
}
