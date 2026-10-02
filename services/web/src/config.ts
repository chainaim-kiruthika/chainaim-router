/**
 * Configuration from the environment. The server holds no wallet key: visitors
 * pay from their own Lute wallet in the browser.
 */
export type WebConfig = {
  port: number;
  host: string;
  paywallUrl: string;
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
  };
}
