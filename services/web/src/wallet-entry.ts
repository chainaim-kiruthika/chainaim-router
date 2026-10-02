/**
 * The browser side of paying with Lute, bundled into public/wallet.js by
 * scripts/build-wallet.ts (npm run build:wallet). The page imports these
 * functions from /wallet.js. Only the address and its network's genesis ID are
 * kept in localStorage; Lute keeps the keys.
 */
import LuteConnect from "lute-connect";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { readAnswer, type Answer, type Failure } from "./answer.ts";
import { readBalance, type Balance, type KnownNetwork } from "./balance.ts";
import { CANCELLED, luteSigner } from "./lute-signer.ts";

export type PayNetwork = { name: KnownNetwork; genesisId: string; algodUrl: string; asset: string };

const KEY = "privacybuddy.lute";
/** A blocked Lute popup never answers, so every Lute call has a time limit. */
const CONNECT_MS = 120_000;
const SIGN_MS = 180_000;
const NO_LUTE = "Lute could not open. Install the Lute extension, or allow pop-ups for this page.";

let lute: LuteConnect | undefined;
const luteApp = () => (lute ??= new LuteConnect("PrivacyBuddy"));

function within<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function savedAccount(): { address: string; genesisId: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { address?: unknown; genesisId?: unknown } | null;
    return v && typeof v.address === "string" && typeof v.genesisId === "string" ? { address: v.address, genesisId: v.genesisId } : null;
  } catch {
    return null;
  }
}

export async function connect(genesisId: string): Promise<string> {
  let addresses: string[];
  try {
    addresses = await within(luteApp().connect(genesisId), CONNECT_MS, NO_LUTE);
  } catch (e) {
    const m = String((e as Error)?.message ?? "");
    throw new Error(/cancel/i.test(m) ? "You closed Lute before connecting. Nothing was shared." : NO_LUTE);
  }
  const address = addresses[0];
  if (!address) throw new Error("Lute did not share an account.");
  try {
    localStorage.setItem(KEY, JSON.stringify({ address, genesisId }));
  } catch {
    /* private window: the page asks again next time */
  }
  return address;
}

export function disconnect(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored */
  }
}

export const balance = (address: string, net: PayNetwork): Promise<Balance> => readBalance(address, net.name, net.asset);

export async function payAndAsk(address: string, net: PayNetwork, masked: string, maxTokens = 512): Promise<Answer | Failure> {
  const signer = luteSigner(address, (txns) => within(luteApp().signTxns(txns), SIGN_MS, NO_LUTE));
  const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer, { algodUrl: net.algodUrl }));
  const paid = wrapFetchWithPayment(fetch, client);
  let r: Response;
  try {
    r = await paid("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chainaim/auto", messages: [{ role: "user", content: masked }], max_tokens: maxTokens }),
    });
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    if (m.includes(CANCELLED)) throw new Error(CANCELLED);
    if (m.includes(NO_LUTE)) throw new Error(NO_LUTE);
    throw new Error(`The payment could not be made (${m.slice(0, 200)}). Nothing was paid.`);
  }
  const text = await r.text();
  let settled: { transaction?: string; network?: string } | undefined;
  try {
    settled = new x402HTTPClient(client).getPaymentSettleResponse((name) => r.headers.get(name)) as typeof settled;
  } catch {
    settled = undefined;
  }
  return readAnswer(r.status, text, (name) => r.headers.get(name), settled);
}
