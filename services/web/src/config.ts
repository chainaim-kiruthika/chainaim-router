/**
 * Configuration from the environment. BUYER_MNEMONIC is read in main.ts and
 * never passes through this module, so it cannot end up in an error message.
 */
export type WebConfig = {
  port: number;
  host: string;
  paywallUrl: string;
  ratePerMinute: number;
  maxExecutesPerHour: number;
};

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, got ${raw}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): WebConfig {
  const paywallUrl = (env.PAYWALL_URL ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(paywallUrl) || !URL.canParse(paywallUrl)) {
    throw new Error("PAYWALL_URL must be the paywall's http(s) address, for example http://127.0.0.1:8080");
  }
  return {
    port: integer(env, "PORT", 8740, 1, 65535),
    host: env.HOST?.trim() || "127.0.0.1",
    paywallUrl,
    ratePerMinute: integer(env, "RATE_PER_MINUTE", 5, 1, 1000),
    maxExecutesPerHour: integer(env, "MAX_EXECUTES_PER_HOUR", 30, 1, 100000),
  };
}
