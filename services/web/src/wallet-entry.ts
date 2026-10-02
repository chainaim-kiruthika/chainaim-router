/**
 * The browser side of paying with Lute, bundled into public/wallet.js by
 * scripts/build-wallet.ts (npm run build:wallet). The page imports these
 * functions from /wallet.js. Only the address and its network's genesis ID are
 * kept in localStorage; Lute keeps the keys.
 */
import LuteConnect from "@galaxypay/lute-connect";
import type { Answer, Failure } from "./answer.ts";
import { readBalance, type Balance } from "./balance.ts";
import { NO_LUTE, payWith, within, type PayNetwork } from "./pay.ts";

export type { PayNetwork };

const KEY = "privacybuddy.lute";
/** A blocked Lute popup never answers, so every Lute call has a time limit. */
const CONNECT_MS = 120_000;

let lute: LuteConnect | undefined;
const luteApp = () => (lute ??= new LuteConnect("PrivacyBuddy"));

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
    if (/cancel/i.test(m)) throw new Error("You closed Lute before connecting. Nothing was shared.");
    if (m === NO_LUTE) throw new Error(NO_LUTE);
    throw new Error(`Lute could not connect: ${m.slice(0, 200)}`);
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

/** Without the extension, Lute signs in a pop-up window, which the browser may block. */
const hasExtension = () => Boolean((window as unknown as { lute?: unknown }).lute);

export function payAndAsk(address: string, net: PayNetwork, masked: string, maxTokens = 512, onSigned?: () => void): Promise<Answer | Failure> {
  const app = luteApp();
  return payWith({ signTxns: (txns) => app.signTxns(txns), fetch: (input, init) => fetch(input, init), popup: !hasExtension(), onSigned }, address, net, masked, maxTokens);
}
