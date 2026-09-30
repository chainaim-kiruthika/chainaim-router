/**
 * Reads that feed the wallet chips: what the paywall asks for (pay-to address,
 * network, asset, price), taken from its own 402 quote, and what a wallet holds,
 * taken from a public Algorand node. Both are read-only.
 */
export type Quote = { payTo: string; network: string; asset: string; price: number };
export type NetworkName = "testnet" | "mainnet" | "unknown";
export type Balance = { algo: number; usdc: number; optedIn: boolean };

const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const NODES = { testnet: "https://testnet-api.algonode.cloud", mainnet: "https://mainnet-api.algonode.cloud" } as const;

export function networkName(caip2: string): NetworkName {
  if (caip2 === TESTNET) return "testnet";
  if (caip2.startsWith("algorand:wGHE2Pw")) return "mainnet";
  return "unknown";
}

/** Ask a paid route for its price without paying: the paywall answers 402 with the quote in a header. */
export async function readQuote(paywallUrl: string, route: string, fetcher: typeof fetch = fetch): Promise<Quote> {
  const r = await fetcher(paywallUrl + route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "hi", messages: [{ role: "user", content: "hi" }] }),
    signal: AbortSignal.timeout(8000),
  });
  const header = r.headers.get("payment-required");
  if (r.status !== 402 || !header) throw new Error(`the paywall did not quote a price (HTTP ${r.status})`);
  const accepts = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { accepts?: Record<string, unknown>[] }).accepts?.[0];
  if (!accepts || typeof accepts.payTo !== "string" || typeof accepts.network !== "string" || accepts.asset === undefined || !Number.isFinite(Number(accepts.amount))) {
    throw new Error("the paywall's quote is not in the expected shape");
  }
  return { payTo: accepts.payTo, network: accepts.network, asset: String(accepts.asset), price: Number(accepts.amount) / 1e6 };
}

export async function readBalance(address: string, network: "testnet" | "mainnet", asset: string, fetcher: typeof fetch = fetch): Promise<Balance> {
  const r = await fetcher(`${NODES[network]}/v2/accounts/${address}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`the Algorand node answered HTTP ${r.status}`);
  const j = (await r.json()) as { amount?: number; assets?: { "asset-id": number; amount: number }[] };
  const held = (j.assets ?? []).find((a) => String(a["asset-id"]) === asset);
  return { algo: (j.amount ?? 0) / 1e6, usdc: held ? held.amount / 1e6 : 0, optedIn: held !== undefined };
}
