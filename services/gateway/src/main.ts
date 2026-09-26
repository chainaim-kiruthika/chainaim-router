/**
 * chainaim-gateway: entry point.
 *
 *   node services/gateway/src/main.ts --catalog config/catalog.json [flags]
 *
 * Every behaviour is a flag with a default; nothing is hard-coded elsewhere.
 */
import { parseArgs } from "node:util";
import { loadCatalog, PROFILES, type Profile } from "./catalog.ts";
import { Engine, type Strategy } from "./engine.ts";
import { Ledger } from "./ledger.ts";
import { Pool } from "./pool.ts";
import { PresidioClient, waitForPresidio } from "./privacy/presidio.ts";
import { createGateway } from "./server.ts";

const USAGE = `chainaim-gateway [flags]

  --catalog PATH             model catalog JSON                         (default config/catalog.json)
  --host HOST                bind address                               (default 127.0.0.1)
  --port N                   listen port                                (default 8700)
  --strategy rules|portfolio route-engine strategy                      (default rules)
  --default-profile P        profile when the request names no model    (default auto; auto|eco|premium)
  --default-max-tokens N     output budget assumed when unset           (default 1024)
  --max-attempts N           dispatch attempts per request              (default 3)
  --attempt-timeout-ms N     wait for upstream response headers         (default 60000)
  --health-interval-ms N     deployment health probe period, 0 = off    (default 10000)
  --health-timeout-ms N      per-probe timeout                          (default 3000)
  --unhealthy-after N        consecutive failures before cooldown       (default 2)
  --cooldown-ms N            how long a failed deployment sits out      (default 30000)
  --presidio-url URL         Presidio analyzer                          (default http://127.0.0.1:5002)
  --presidio-threshold N     minimum entity score, 0 to 1               (default 0.4)
  --presidio-timeout-ms N    per Presidio call                          (default 10000)
  --presidio-wait-ms N       how long start-up waits for Presidio       (default 120000)
  --presidio-check-ms N      Presidio health check period               (default 30000)
  --ledger DIR|off           decision ledger directory                  (default data/ledger)
  --max-body-bytes N         request size limit                         (default 4194304)
  --api-key-env NAME         env var holding the gateway bearer key     (default none = no auth)
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

export function parseFlags(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      catalog: { type: "string", default: "config/catalog.json" },
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8700" },
      strategy: { type: "string", default: "rules" },
      "default-profile": { type: "string", default: "auto" },
      "default-max-tokens": { type: "string", default: "1024" },
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
      ledger: { type: "string", default: "data/ledger" },
      "max-body-bytes": { type: "string", default: String(4 * 1024 * 1024) },
      "api-key-env": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.strategy !== "rules" && values.strategy !== "portfolio") throw new Error("--strategy must be rules or portfolio");
  if (!(PROFILES as readonly string[]).includes(values["default-profile"]!)) throw new Error(`--default-profile must be one of ${PROFILES.join(", ")}`);
  if (!URL.canParse(values["presidio-url"]!)) throw new Error("--presidio-url must be a URL");
  return {
    help: values.help!,
    catalog: values.catalog!,
    host: values.host!,
    port: int("port", values.port!, 0),
    strategy: values.strategy as Strategy,
    defaultProfile: values["default-profile"] as Profile,
    defaultMaxTokens: int("default-max-tokens", values["default-max-tokens"]!, 1),
    maxAttempts: int("max-attempts", values["max-attempts"]!, 1),
    attemptTimeoutMs: int("attempt-timeout-ms", values["attempt-timeout-ms"]!, 1),
    healthIntervalMs: int("health-interval-ms", values["health-interval-ms"]!, 0),
    healthTimeoutMs: int("health-timeout-ms", values["health-timeout-ms"]!, 1),
    unhealthyAfter: int("unhealthy-after", values["unhealthy-after"]!, 1),
    cooldownMs: int("cooldown-ms", values["cooldown-ms"]!, 0),
    presidioUrl: values["presidio-url"]!,
    presidioThreshold: num("presidio-threshold", values["presidio-threshold"]!, 0, 1),
    presidioTimeoutMs: int("presidio-timeout-ms", values["presidio-timeout-ms"]!, 1),
    presidioWaitMs: int("presidio-wait-ms", values["presidio-wait-ms"]!, 0),
    presidioCheckMs: int("presidio-check-ms", values["presidio-check-ms"]!, 0),
    ledgerDir: values.ledger === "off" ? undefined : values.ledger!,
    maxBodyBytes: int("max-body-bytes", values["max-body-bytes"]!, 1024),
    apiKeyEnv: values["api-key-env"],
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

  // Refuse to start without a Presidio that detects every required entity (V4).
  const presidio = new PresidioClient({ url: f.presidioUrl, threshold: f.presidioThreshold, timeoutMs: f.presidioTimeoutMs });
  await waitForPresidio(presidio, f.presidioWaitMs);
  presidio.start(f.presidioCheckMs);

  const catalog = loadCatalog(f.catalog);
  const engine = new Engine(catalog, { strategy: f.strategy, defaultProfile: f.defaultProfile, defaultMaxTokens: f.defaultMaxTokens });
  const pool = new Pool({
    healthIntervalMs: f.healthIntervalMs,
    healthTimeoutMs: f.healthTimeoutMs,
    unhealthyAfter: f.unhealthyAfter,
    cooldownMs: f.cooldownMs,
    env: process.env,
  });
  pool.setModels(catalog.models);
  const ledger = new Ledger(f.ledgerDir);
  await pool.checkAll();
  pool.start();

  const server = createGateway(
    { engine, pool, ledger, presidio },
    { maxAttempts: f.maxAttempts, attemptTimeoutMs: f.attemptTimeoutMs, maxBodyBytes: f.maxBodyBytes, gatewayKey },
  );
  server.listen(f.port, f.host, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : f.port;
    const down = pool.unavailableModels();
    console.log(
      `[chainaim-gateway] listening on http://${f.host}:${port}  catalog=${catalog.version} models=${catalog.models.length} ` +
        `strategy=${f.strategy} presidio=${presidio.url} ledger=${ledger.enabled ? f.ledgerDir : "off"} auth=${gatewayKey ? "on" : "off"}` +
        (down.length ? `  unavailable=${down.join(",")}` : ""),
    );
  });
  const shutdown = () => {
    pool.stop();
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
