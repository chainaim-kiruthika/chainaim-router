import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { SECURITY_HEADERS } from "../src/app.ts";
import { buildVercel } from "../scripts/build-vercel.ts";

const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const PAYTO = "EA7WASZQYXGGRSMGYQLRI6TR2PQCVDC42QULUT5N62UMYO4A6ADCJ6464M";
const quote = Buffer.from(JSON.stringify({ accepts: [{ scheme: "exact", network: TESTNET, amount: "10000", asset: "10458941", payTo: PAYTO }] })).toString("base64");

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** A plain request with no keep-alive (a pooled socket still closing at exit can crash Node on Windows). */
function call(port: number, method: string, path: string, body?: string) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, agent: false, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("buildVercel", () => {
  let out: string;
  let paywall: Server;
  let paywallCalls = 0;

  before(async () => {
    out = mkdtempSync(join(tmpdir(), "pb-vercel-"));
    await buildVercel(pathToFileURL(out + "/"));
    // A stand-in paywall: every paid route answers 402 with a quote.
    paywall = createServer((_req, res) => {
      paywallCalls++;
      res.writeHead(402, { "payment-required": quote, "content-type": "application/json" }).end("{}");
    });
  });

  after(async () => {
    if (paywall.listening) await close(paywall);
    rmSync(out, { recursive: true, force: true });
  });

  it("puts the page, the wallet bundle and the masking module in static/", () => {
    assert.match(readFileSync(join(out, "static/index.html"), "utf8"), /PrivacyBuddy/);
    assert.match(readFileSync(join(out, "static/wallet.js"), "utf8"), /PrivacyBuddy wallet bundle/);
    assert.match(readFileSync(join(out, "static/client-mask.js"), "utf8"), /export function maskText/);
  });

  it("sends the same security headers as the Node server on every path", () => {
    const config = JSON.parse(readFileSync(join(out, "config.json"), "utf8"));
    assert.equal(config.version, 3);
    assert.deepEqual(config.routes[0], { src: "/(.*)", headers: SECURITY_HEADERS, continue: true });
    assert.deepEqual(config.routes[1], { handle: "filesystem" });
  });

  it("makes one Node function per API route with room for a slow paid answer", () => {
    for (const name of ["wallets", "chat"]) {
      const vc = JSON.parse(readFileSync(join(out, `functions/api/${name}.func/.vc-config.json`), "utf8"));
      assert.deepEqual(vc, { runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, maxDuration: 300 });
    }
  });

  it("runs the built function against the paywall in PAYWALL_URL", async () => {
    const paywallPort = await listen(paywall);
    process.env.PAYWALL_URL = `http://127.0.0.1:${paywallPort}`;
    const fn = await import(pathToFileURL(join(out, "functions/api/wallets.func/index.mjs")).href + "?with-url");
    delete process.env.PAYWALL_URL;
    const server = createServer(fn.default);
    const port = await listen(server);
    try {
      const wallets = await call(port, "GET", "/api/wallets");
      assert.equal(wallets.status, 200);
      assert.equal(wallets.json.network, "testnet");
      assert.equal(wallets.json.payTo.address, PAYTO);

      const before = paywallCalls;
      const unmasked = await call(port, "POST", "/api/chat", JSON.stringify({ model: "chainaim/auto", messages: [{ role: "user", content: "Email priya.raman@example.com" }] }));
      assert.equal(unmasked.status, 400);
      assert.equal(paywallCalls, before, "unmasked text never reaches the paywall");
    } finally {
      await close(server);
    }
  });

  it("answers a clear 500 when PAYWALL_URL is not set on Vercel", async () => {
    delete process.env.PAYWALL_URL;
    const fn = await import(pathToFileURL(join(out, "functions/api/chat.func/index.mjs")).href + "?no-url");
    const server = createServer(fn.default);
    const port = await listen(server);
    try {
      const r = await call(port, "GET", "/api/wallets");
      assert.equal(r.status, 500);
      assert.match(r.json.error.message, /PAYWALL_URL/);
    } finally {
      await close(server);
    }
  });
});
