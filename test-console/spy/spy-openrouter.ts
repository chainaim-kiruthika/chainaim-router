/**
 * Local test only: the stub OpenRouter, recording every chat body and every
 * Decisions API (Jev) body it receives, so a tester can see exactly what
 * would leave ChainAim. It prints them and serves the last ones as JSON on
 * port 5004. Synthetic stand-in; no real model is called.
 */
import { createServer } from "node:http";
import { startStubOpenRouter } from "/app/scripts/stub-openrouter.ts";

const stub = await startStubOpenRouter(5003, "::");
console.log(`[spy-openrouter] ${stub.url}`);

type Seen = { at: string; kind: "model" | "jev"; body: unknown };
const seen: Seen[] = [];
let chats = 0;
let decisions = 0;
setInterval(() => {
  while (chats < stub.chatBodies.length) {
    const b = stub.chatBodies[chats++] as { model?: unknown; provider?: unknown; messages?: unknown };
    const body = { model: b.model, provider: b.provider, messages: b.messages };
    seen.push({ at: new Date().toISOString(), kind: "model", body });
    console.log(`MODEL RECEIVED ${JSON.stringify(body)}`);
  }
  while (decisions < stub.decisionBodies.length) {
    const b = stub.decisionBodies[decisions++] as { state?: unknown };
    seen.push({ at: new Date().toISOString(), kind: "jev", body: b.state });
    console.log(`JEV RECEIVED ${JSON.stringify(b.state)}`);
  }
  if (seen.length > 50) seen.splice(0, seen.length - 50);
}, 100);

createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(seen.slice(-20)));
}).listen(5004, "::");
