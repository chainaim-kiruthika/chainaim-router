import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NETWORKS, readBalance } from "../src/balance.ts";

describe("NETWORKS", () => {
  it("names Lute's genesis IDs and the public algod nodes", () => {
    assert.deepEqual(NETWORKS, {
      testnet: { genesisId: "testnet-v1.0", algodUrl: "https://testnet-api.algonode.cloud" },
      mainnet: { genesisId: "mainnet-v1.0", algodUrl: "https://mainnet-api.algonode.cloud" },
    });
  });
});

describe("readBalance", () => {
  const node = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

  it("reads ALGO and the USDC held", async () => {
    const b = await readBalance("ADDR", "testnet", "10458941", node({ amount: 3_999_000, assets: [{ "asset-id": 10458941, amount: 2_500_000 }] }));
    assert.deepEqual(b, { algo: 3.999, usdc: 2.5, optedIn: true });
  });

  it("reports an account that has not opted in to the asset", async () => {
    const b = await readBalance("ADDR", "testnet", "10458941", node({ amount: 4_000_000, assets: [] }));
    assert.deepEqual(b, { algo: 4, usdc: 0, optedIn: false });
  });

  it("uses the node for the right network", async () => {
    let seen = "";
    await readBalance("ADDR", "mainnet", "31566704", async (input) => {
      seen = String(input);
      return new Response("{}");
    });
    assert.match(seen, /^https:\/\/mainnet-api\.algonode\.cloud\/v2\/accounts\/ADDR$/);
  });

  it("fails clearly when the node errors", async () => {
    await assert.rejects(readBalance("ADDR", "testnet", "1", node({}, 500)), /HTTP 500/);
  });
});
