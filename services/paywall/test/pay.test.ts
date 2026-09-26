/**
 * scripts/pay.ts against a local paywall with the stub facilitator: --dry-run
 * reads the price and pays nothing. The paying path needs a funded buyer
 * account; the owner runs it (docs/deploy/railway.md).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { close, listen, PAY_TO, startPaywall, stubFacilitator, stubGateway } from "./stubs.ts";

const cwd = fileURLToPath(new URL("../", import.meta.url));

/** Async on purpose: the paywall runs in this process and must keep answering. */
function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/pay.ts", ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("scripts/pay.ts", () => {
  const facilitator = stubFacilitator();
  const gateway = stubGateway();
  let paywall: { url: string; close: () => Promise<void> };
  before(async () => {
    paywall = await startPaywall({
      AVM_PAY_TO: PAY_TO,
      GATEWAY_URL: await listen(gateway.server),
      CHAINAIM_GATEWAY_KEY: "test-key",
      FACILITATOR_URL: await listen(facilitator.server),
    });
  });
  after(async () => {
    await paywall.close();
    await close(facilitator.server);
    await close(gateway.server);
  });

  it("--dry-run shows the price, network, payTo and tag, and pays nothing", async () => {
    const r = await run(["--dry-run", `${paywall.url}/v1/privacy/scan`, JSON.stringify({ text: "hi" })]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes("price 0.002 USDC (asset 10458941)"), r.stdout);
    assert.ok(r.stdout.includes(`to ${PAY_TO}; tag=x402-global-challenge`), r.stdout);
    assert.ok(r.stdout.includes("bazaar=yes"), r.stdout);
    assert.ok(!facilitator.calls.includes("/verify") && !facilitator.calls.includes("/settle"), "nothing was verified or settled");
  });

  it("needs a URL", async () => {
    const r = await run([]);
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("usage"), r.stderr);
  });

  it("refuses to pay without AVM_MNEMONIC", async () => {
    const r = await run([`${paywall.url}/v1/privacy/scan`, JSON.stringify({ text: "hi" })], { AVM_MNEMONIC: "" });
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("AVM_MNEMONIC"), r.stderr);
  });
});
