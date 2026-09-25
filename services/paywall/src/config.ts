/**
 * Paywall configuration from the environment (spec sections 9 and 10). The
 * gateway key is the only secret, and it is never logged.
 */
export const NETWORKS = {
  testnet: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
  mainnet: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
} as const;
export type NetworkName = keyof typeof NETWORKS;

/** Required on every accepts entry for the Global x402 Challenge (V3). */
export const CHALLENGE_TAG = "x402-global-challenge";
export const DEFAULT_FACILITATOR = "https://facilitator.goplausible.xyz";

export type PaywallConfig = {
  network: string;
  networkName: NetworkName;
  /** The one Algorand account every route pays. */
  payTo: string;
  facilitatorUrl: string;
  /** The private gateway, e.g. http://gateway.railway.internal:8700 */
  gatewayUrl: string;
  gatewayKey: string;
  /** How long a proxied call may take; chat can try three models. */
  gatewayTimeoutMs: number;
  port: number;
  host: string;
  /** Public origin such as https://pay.example.com: the resource URL in 402s and the Bazaar. */
  publicBaseUrl: string | undefined;
};

export function loadConfig(env: Record<string, string | undefined>): PaywallConfig {
  const value = (name: string): string | undefined => env[name]?.trim() || undefined;
  const required = (name: string): string => {
    const v = value(name);
    if (!v) throw new Error(`${name} is required`);
    return v;
  };
  const integer = (name: string, fallback: number): number => {
    const v = value(name);
    const n = v === undefined ? fallback : Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number, got ${v}`);
    return n;
  };

  const networkName = value("X402_NETWORK") ?? "testnet";
  if (!Object.hasOwn(NETWORKS, networkName)) throw new Error("X402_NETWORK must be testnet or mainnet");
  const payTo = required("AVM_PAY_TO");
  if (!/^[A-Z2-7]{58}$/.test(payTo)) throw new Error("AVM_PAY_TO must be a 58-character Algorand address");
  const gatewayUrl = required("GATEWAY_URL").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(gatewayUrl) || !URL.canParse(gatewayUrl)) throw new Error("GATEWAY_URL must be an http(s) URL");
  const publicBaseUrl = value("PUBLIC_BASE_URL")?.replace(/\/+$/, "");
  if (publicBaseUrl !== undefined && (!publicBaseUrl.startsWith("https://") || !URL.canParse(publicBaseUrl))) {
    throw new Error("PUBLIC_BASE_URL must be an https URL");
  }
  return {
    network: NETWORKS[networkName as NetworkName],
    networkName: networkName as NetworkName,
    payTo,
    facilitatorUrl: (value("FACILITATOR_URL") ?? DEFAULT_FACILITATOR).replace(/\/+$/, ""),
    gatewayUrl,
    gatewayKey: required("CHAINAIM_GATEWAY_KEY"),
    gatewayTimeoutMs: integer("GATEWAY_TIMEOUT_MS", 200_000),
    port: integer("PORT", 8080),
    host: value("HOST") ?? "0.0.0.0",
    publicBaseUrl,
  };
}
