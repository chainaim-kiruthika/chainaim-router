/**
 * Stub OpenAI-compatible model servers, for testing the gateway without weights.
 *
 *   node scripts/stub-models.ts [--ports 8081,8082] [--names qwen2.5-0.5b,qwen2.5-1.5b]
 *
 * Defaults impersonate the llama.cpp deployments in config/catalog.json, so the
 * gateway runs against the real catalog unchanged. Answers are echoes, not
 * inference: this exercises routing, dispatch, fallback, health and the ledger,
 * never answer quality.
 *
 * Each server exposes a control endpoint so failover can be driven from a test:
 *   GET /admin/mode?m=ok|fail500|slow   force behaviour
 *   GET /admin/stats                    mode + request count
 */
import { createServer, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";

const { values: f } = parseArgs({
  options: {
    ports: { type: "string", default: "8081,8082" },
    names: { type: "string", default: "qwen2.5-0.5b,qwen2.5-1.5b" },
    "delay-ms": { type: "string", default: "150,600" },
    host: { type: "string", default: "127.0.0.1" },
  },
});

const ports = f.ports!.split(",").map((s) => Number(s.trim()));
const names = f.names!.split(",").map((s) => s.trim());
const delays = f["delay-ms"]!.split(",").map((s) => Number(s.trim()));
if (ports.length !== names.length) throw new Error("--ports and --names must have the same length");

type Mode = "ok" | "fail500" | "slow";

for (const [i, port] of ports.entries()) {
  const name = names[i];
  const delayMs = delays[i] ?? delays[delays.length - 1] ?? 150;
  let mode: Mode = "ok";
  let hits = 0;

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };

  createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub.local");

    if (url.pathname === "/admin/mode") {
      mode = (url.searchParams.get("m") as Mode) ?? "ok";
      console.log(`[${name}] mode -> ${mode}`);
      return json(res, 200, { model: name, mode });
    }
    if (url.pathname === "/admin/stats") return json(res, 200, { model: name, mode, hits });

    // llama.cpp liveness endpoint, which config/catalog.json points healthUrl at.
    if (url.pathname === "/health") {
      return mode === "fail500"
        ? json(res, 503, { status: "error", error: { message: "stub: forced unhealthy" } })
        : json(res, 200, { status: "ok" });
    }
    if (url.pathname === "/v1/models") {
      return json(res, 200, { object: "list", data: [{ id: name, object: "model", owned_by: "stub" }] });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      hits++;
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body: { messages?: { role?: string; content?: unknown }[]; stream?: boolean; model?: string };
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: { message: "stub: body is not valid JSON" } });
      }

      if (mode === "fail500") return json(res, 500, { error: { message: "stub: forced upstream failure" } });
      if (mode === "slow") await new Promise((r) => setTimeout(r, 3000));
      await new Promise((r) => setTimeout(r, delayMs));

      const last = (body.messages ?? []).filter((m) => m?.role === "user").pop()?.content;
      const text = typeof last === "string" ? last : "[non-text content]";
      const answer = `[${name}] echo: ${text.slice(0, 120)}`;

      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const word of answer.split(" ")) {
          const chunk = { id: "stub", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: word + " " } }] };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          await new Promise((r) => setTimeout(r, 25));
        }
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      return json(res, 200, {
        id: `chatcmpl-stub-${hits}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        usage: { prompt_tokens: Math.ceil(text.length / 4), completion_tokens: Math.ceil(answer.length / 4), total_tokens: 0 },
      });
    }

    json(res, 404, { error: { message: `stub: no route ${req.method} ${url.pathname}` } });
  }).listen(port, f.host!, () => console.log(`[stub] ${name} on http://${f.host}:${port}/v1`));
}
