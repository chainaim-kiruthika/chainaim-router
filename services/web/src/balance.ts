/**
 * What a wallet holds, read from a public Algorand node, and the per-network
 * constants Lute and the x402 client need. No Node-only APIs: the browser
 * bundle (wallet-entry.ts) imports this file too.
 */
export type KnownNetwork = "testnet" | "mainnet";
export type Balance = { algo: number; usdc: number; optedIn: boolean };

export const NETWORKS: Record<KnownNetwork, { genesisId: string; algodUrl: string }> = {
  testnet: { genesisId: "testnet-v1.0", algodUrl: "https://testnet-api.algonode.cloud" },
  mainnet: { genesisId: "mainnet-v1.0", algodUrl: "https://mainnet-api.algonode.cloud" },
};

export async function readBalance(address: string, network: KnownNetwork, asset: string, fetcher: typeof fetch = fetch): Promise<Balance> {
  const r = await fetcher(`${NETWORKS[network].algodUrl}/v2/accounts/${address}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`the Algorand node answered HTTP ${r.status}`);
  const j = (await r.json()) as { amount?: number; assets?: { "asset-id": number; amount: number }[] };
  const held = (j.assets ?? []).find((a) => String(a["asset-id"]) === asset);
  return { algo: (j.amount ?? 0) / 1e6, usdc: held ? held.amount / 1e6 : 0, optedIn: held !== undefined };
}
