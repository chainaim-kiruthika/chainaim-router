/**
 * Test doubles for the paywall: a facilitator that accepts every payment and
 * records which endpoints were called, and a gateway that records what
 * reaches it. No real payment and no network call leave the machine.
 */
import { EventEmitter } from "node:events";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createPaywall } from "../src/app.ts";
import { loadConfig, NETWORKS } from "../src/config.ts";

/** Synthetic Algorand address used as payTo and fee payer. */
export const PAY_TO = "IDNTKBLAMSMIBR5DV5GRRZC7PNDOGRUOSOLHZ7BIOVXJPOWT2O24BMVDPE";

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export function close(server: Server): Promise<void> {
  return new Promise((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

/** Supports both networks, says every payment is valid, and settles with a fake transaction id. */
export function stubFacilitator(): { server: Server; calls: string[] } {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    await readBody(req);
    calls.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url === "/supported") {
      const kinds = Object.values(NETWORKS).map((network) => ({ x402Version: 2, scheme: "exact", network, extra: { feePayer: PAY_TO } }));
      res.end(JSON.stringify({ kinds, extensions: ["bazaar"], signers: {} }));
    } else if (req.url === "/verify") {
      res.end(JSON.stringify({ isValid: true, payer: "BUYERADDRESS" }));
    } else if (req.url === "/settle") {
      res.end(JSON.stringify({ success: true, transaction: "TX-STUB-1", network: NETWORKS.testnet, payer: "BUYERADDRESS" }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  return { server, calls };
}

export type Seen = { method: string; path: string; headers: IncomingHttpHeaders; body: string };

export type GatewayState = { status: number; capacityStatus: number; capacity: Record<string, unknown>; delayMs: number };

/**
 * Records every request. Paid paths answer with state.status, after
 * state.delayMs when it is set: `events` then emits "held" when such a call
 * arrives, and "outcome" with "answered", or "dropped" when the paywall hung
 * up first. /internal/capacity answers with state.capacity.
 */
export function stubGateway(): { server: Server; seen: Seen[]; state: GatewayState; events: EventEmitter } {
  const seen: Seen[] = [];
  const state: GatewayState = { status: 200, capacityStatus: 200, capacity: { chatAvailable: true }, delayMs: 0 };
  const events = new EventEmitter();
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const path = new URL(req.url ?? "/", "http://gateway.local").pathname;
    seen.push({ method: req.method ?? "", path, headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    if (path === "/internal/capacity") {
      res.statusCode = state.capacityStatus;
      res.end(JSON.stringify(state.capacity));
      return;
    }
    if (path === "/healthz" || path === "/v1/models") {
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    const answer = (): void => {
      res.statusCode = state.status;
      res.setHeader("x-chainaim-decision-id", "decision-1");
      res.setHeader("x-internal-note", "must not reach the caller");
      res.end(JSON.stringify(state.status < 400 ? { ok: true } : { error: { message: "refused", code: state.status } }));
    };
    if (state.delayMs <= 0) return answer();
    const timer = setTimeout(() => {
      answer();
      events.emit("outcome", "answered");
    }, state.delayMs);
    res.on("close", () => {
      if (res.writableFinished) return;
      clearTimeout(timer);
      events.emit("outcome", "dropped");
    });
    events.emit("held");
  });
  return { server, seen, state, events };
}

/** A paywall on a loopback port. */
export async function startPaywall(env: Record<string, string>, log?: (line: string) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createPaywall(loadConfig(env), { log: log ?? (() => {}) });
  let server: Server | undefined;
  const url = await new Promise<string>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(`http://127.0.0.1:${info.port}`)) as Server;
  });
  return { url, close: () => close(server!) };
}
