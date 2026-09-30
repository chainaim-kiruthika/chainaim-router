import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { get } from "node:http";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

/** A plain GET with no keep-alive: a pooled connection still closing when the runner exits can crash Node on Windows. */
const getText = (url: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    get(url, { agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
  });

describe("main", () => {
  it("exits with a clear message when PAYWALL_URL is missing", () => {
    const r = spawnSync(process.execPath, [MAIN], { env: { ...process.env, PAYWALL_URL: "" }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PAYWALL_URL/);
  });

  it("exits with a clear message, without echoing the words, when BUYER_MNEMONIC is not a valid phrase", () => {
    const r = spawnSync(process.execPath, [MAIN], { env: { ...process.env, PAYWALL_URL: "http://127.0.0.1:1", BUYER_MNEMONIC: "totally invalid words here" }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /BUYER_MNEMONIC/);
    assert.ok(!r.stderr.includes("totally invalid words here"));
  });

  it("starts without a buyer key and serves the page and /healthz", async () => {
    const port = 18741;
    const child = spawn(process.execPath, [MAIN], { env: { ...process.env, PAYWALL_URL: "http://127.0.0.1:1", PORT: String(port), BUYER_MNEMONIC: "" }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("did not start")), 15000);
        child.stdout.on("data", (d) => {
          if (String(d).includes("privacybuddy")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("exit", (code) => reject(new Error("exited " + code)));
      });
      const health = await getText(`http://127.0.0.1:${port}/healthz`);
      assert.deepEqual(JSON.parse(health.body), { status: "ok" });
      const page = await getText(`http://127.0.0.1:${port}/`);
      assert.equal(page.status, 200);
      assert.match(page.body, /PrivacyBuddy/);
    } finally {
      // Wait for the child to be gone and close its pipes, or Node on Windows can crash while shutting down.
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });
});
