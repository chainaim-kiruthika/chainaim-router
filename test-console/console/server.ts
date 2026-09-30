/**
 * Local test console for the ChainAim stack running in Docker on this PC.
 * Serves one page and forwards its calls: scan, mask and chat to the gateway
 * (adding the local test key), unpaid calls to the paywall (to show the 402),
 * the spy stand-in's record of what left, and the last ledger lines.
 *
 *   node server.ts   ->  http://127.0.0.1:8730
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const KEY = readFileSync(new URL("../local-gateway-key.txt", import.meta.url), "utf8").trim();
const GATEWAY = "http://127.0.0.1:8720";
const PAYWALL = "http://127.0.0.1:8080";
const SPY = "http://127.0.0.1:5004";
const PAGE = new URL("./index.html", import.meta.url);

const ROUTES: Record<string, string> = { scan: "/v1/privacy/scan", mask: "/v1/privacy/mask", chat: "/v1/chat/completions" };

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://console");
    const [, api, name] = url.pathname.split("/");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(PAGE));
      return;
    }
    if (api === "gateway" && req.method === "POST" && ROUTES[name]) {
      const r = await fetch(GATEWAY + ROUTES[name], {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: await readBody(req),
      });
      const headers = Object.fromEntries([...r.headers].filter(([k]) => k.startsWith("x-chainaim")));
      json(res, 200, { status: r.status, headers, body: await r.json().catch(() => null) });
      return;
    }
    if (api === "paywall" && ROUTES[name]) {
      const body = name === "chat" ? { messages: [{ role: "user", content: "hi" }] } : { text: "hi" };
      const r = await fetch(PAYWALL + ROUTES[name], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const header = r.headers.get("payment-required");
      const required = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null;
      json(res, 200, {
        status: r.status,
        accepts: required?.accepts?.map((a: Record<string, any>) => ({ price: Number(a.amount) / 1e6, network: a.network, asset: a.asset, payTo: a.payTo, tag: a.extra?.tag })) ?? [],
        bazaar: Boolean(required?.extensions?.bazaar),
        body: header ? null : await r.json().catch(() => null),
      });
      return;
    }
    if (api === "leaving") {
      json(res, 200, await (await fetch(SPY)).json());
      return;
    }
    if (api === "ledger") {
      execFile("docker", ["exec", "ca-gateway", "sh", "-c", "tail -n 6 /data/ledger/*.jsonl"], (err, out) => {
        const lines = err ? [] : out.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return l; } });
        json(res, 200, { lines });
      });
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 502, { error: (e as Error).message });
  }
}).listen(8730, "127.0.0.1", () => console.log("[test-console] http://127.0.0.1:8730"));
