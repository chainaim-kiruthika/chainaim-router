/**
 * Stub Presidio analyzer, for tests and local runs without Docker. It
 * "detects" the synthetic corpus values (scripts/synthetic-corpus.ts) and any
 * deny-list terms sent as ad-hoc recognizers, and reports offsets in code
 * points, like the real (Python) service.
 *
 *   node scripts/stub-presidio.ts [--port 5002]
 *
 * Modes (set `mode` on the handle, or GET /admin/mode?m=...):
 *   ok | fail (every route answers 500) | malformed (entities without offsets)
 *   | missing-entities (/supportedentities leaves out IN_AADHAAR)
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseArgs } from "node:util";
import { KNOWN_VALUES } from "./synthetic-corpus.ts";

export type StubPresidioMode = "ok" | "fail" | "malformed" | "missing-entities";
export type StubPresidio = { url: string; mode: StubPresidioMode; requests: Record<string, unknown>[]; close: () => Promise<void> };
type Found = { entity_type: string; start: number; end: number; score: number };

export const STUB_SUPPORTED_ENTITIES: readonly string[] = [
  "PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "IN_AADHAAR", "IN_PAN", "US_SSN", "IP_ADDRESS", "IBAN_CODE",
  "US_PASSPORT", "US_DRIVER_LICENSE", "CRYPTO", "CREDIT_CARD", "MEDICAL_LICENSE", "LOCATION", "DATE_TIME", "NRP", "URL",
];

const codePoints = (text: string, utf16: number): number => [...text.slice(0, utf16)].length;

function occurrences(haystack: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) at.push(i);
  return at;
}

/** What the stub finds in one text: corpus values anywhere, deny-list terms as whole words in any case. */
export function stubDetect(text: string, denyList: readonly string[]): Found[] {
  const found: Found[] = [];
  const add = (type: string, i: number, length: number, score: number): void => {
    found.push({ entity_type: type, start: codePoints(text, i), end: codePoints(text, i + length), score });
  };
  for (const { value, type } of KNOWN_VALUES) for (const i of occurrences(text, value)) add(type, i, value.length, 0.85);
  const lower = text.toLowerCase();
  for (const term of denyList) {
    const t = term.toLowerCase();
    for (const i of occurrences(lower, t)) {
      if (/\w/.test(lower[i - 1] ?? "") || /\w/.test(lower[i + t.length] ?? "")) continue;
      add("HEALTH_TERM", i, t.length, 1);
    }
  }
  return found;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function startStubPresidio(port = 0, host = "127.0.0.1"): Promise<StubPresidio> {
  const stub = { url: "", mode: "ok", requests: [], close: async () => {} } as StubPresidio;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub.local");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (url.pathname === "/admin/mode") {
      stub.mode = (url.searchParams.get("m") ?? "ok") as StubPresidioMode;
      return json(res, 200, { mode: stub.mode });
    }
    if (stub.mode === "fail") return json(res, 500, { error: "stub: forced failure" });
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("Presidio Analyzer service is up");
      return;
    }
    if (req.method === "GET" && url.pathname === "/supportedentities") {
      return json(res, 200, stub.mode === "missing-entities" ? STUB_SUPPORTED_ENTITIES.filter((e) => e !== "IN_AADHAAR") : STUB_SUPPORTED_ENTITIES);
    }
    if (req.method === "POST" && url.pathname === "/analyze") {
      const body = JSON.parse(raw) as { text?: unknown; entities?: string[]; ad_hoc_recognizers?: { deny_list?: string[] }[] };
      stub.requests.push(body as Record<string, unknown>);
      if (!body.text) return json(res, 500, { error: "No text provided" }); // like the real service
      const deny = (body.ad_hoc_recognizers ?? []).flatMap((r) => r.deny_list ?? []);
      const one = (text: string): unknown[] => {
        if (stub.mode === "malformed") return [{ entity_type: "PERSON", score: 0.85 }];
        return stubDetect(text, deny).filter((e) => !body.entities || body.entities.includes(e.entity_type));
      };
      return json(res, 200, Array.isArray(body.text) ? body.text.map((t) => one(String(t))) : one(String(body.text)));
    }
    json(res, 404, { error: `stub: no route ${req.method} ${url.pathname}` });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      stub.url = `http://${host}:${(server.address() as AddressInfo).port}`;
      stub.close = () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        });
      resolve(stub);
    });
  });
}

if (import.meta.main ?? process.argv[1]?.endsWith("stub-presidio.ts")) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "5002" }, host: { type: "string", default: "127.0.0.1" } } });
  const stub = await startStubPresidio(Number(values.port), values.host);
  console.log(`[stub-presidio] ${stub.url}  (synthetic corpus only; GET /admin/mode?m=ok|fail|malformed|missing-entities)`);
}
