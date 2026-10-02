/**
 * One paid chat call: the x402 client asks /api/chat, Lute signs the payment,
 * and the reply becomes an Answer or one plain sentence. Lute and fetch are
 * passed in, so this file has no browser dependency: test/pay.test.ts drives
 * it in Node, and wallet-entry.ts passes the real LuteConnect and fetch.
 *
 * Money rule: once Lute has signed, a failure never says "not charged",
 * because the payment may have settled.
 */
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { readAnswer, type Answer, type Failure } from "./answer.ts";
import type { KnownNetwork } from "./balance.ts";
import { CANCELLED, NOT_SIGNED, luteSigner, type AvmSigner, type SignTxns } from "./lute-signer.ts";

export type PayNetwork = { name: KnownNetwork; genesisId: string; algodUrl: string; asset: string };

type SchemeConfig = NonNullable<ConstructorParameters<typeof ExactAvmScheme>[1]>;

export type PayDeps = {
  /** Lute's signTxns, untimed: payWith adds the time limit. */
  signTxns: SignTxns;
  fetch: typeof fetch;
  /** True when Lute has no extension here and signs in a pop-up window. */
  popup: boolean;
  /** Called once Lute has returned the signatures. */
  onSigned?: () => void;
  /** The chat route; the browser uses the page-relative default. */
  chatUrl?: string;
  /** Sign time limit in ms (tests shorten it). */
  signMs?: number;
  /** For tests: an Algorand client with cached suggested params, so no node is called. */
  algorandClient?: SchemeConfig["algorandClient"];
};

/** A blocked Lute pop-up never answers, so every Lute call has a time limit. */
const SIGN_MS = 180_000;
export const NO_LUTE = "Lute could not open. Install the Lute extension, or allow pop-ups for this page.";
export const SIGN_TIMEOUT = "Lute did not answer in time. Nothing was paid.";
export const SIGN_TIMEOUT_POPUP = "Lute did not answer in time. If no Lute window appeared, allow pop-ups for this page. Nothing was paid.";
export const AFTER_APPROVAL = "The connection failed after you approved the payment. Check your wallet's recent transactions before trying again.";

export function within<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function payWith(deps: PayDeps, address: string, net: PayNetwork, masked: string, maxTokens = 512): Promise<Answer | Failure> {
  const timeoutMessage = deps.popup ? SIGN_TIMEOUT_POPUP : SIGN_TIMEOUT;
  let signed = false;
  const inner = luteSigner(address, (txns) => within(deps.signTxns(txns), deps.signMs ?? SIGN_MS, timeoutMessage));
  // Marked signed only after luteSigner has checked every signature we asked for.
  const signer: AvmSigner = {
    address,
    async signTransactions(txns, indexesToSign) {
      const out = await inner.signTransactions(txns, indexesToSign);
      signed = true;
      try {
        deps.onSigned?.();
      } catch {
        /* a status line must not break the payment */
      }
      return out;
    },
  };
  const scheme = new ExactAvmScheme(signer, deps.algorandClient ? { algorandClient: deps.algorandClient } : { algodUrl: net.algodUrl });
  const client = new x402Client().register("algorand:*", scheme);
  const paid = wrapFetchWithPayment(deps.fetch, client);
  let r: Response;
  try {
    r = await paid(deps.chatUrl ?? "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "chainaim/auto", messages: [{ role: "user", content: masked }], max_tokens: maxTokens }),
    });
  } catch (e) {
    // The visitor sees one plain sentence; the console keeps the real error for debugging (it holds no text or keys).
    console.error("[privacybuddy] paid call failed", { signed, error: e });
    const m = String((e as Error)?.message ?? e);
    if (m.includes(CANCELLED)) throw new Error(CANCELLED);
    if (m.includes(timeoutMessage)) throw new Error(timeoutMessage);
    if (m.includes(NOT_SIGNED)) throw new Error(NOT_SIGNED);
    if (m.includes(NO_LUTE)) throw new Error(NO_LUTE);
    if (signed) throw new Error(AFTER_APPROVAL);
    throw new Error(`The payment could not be made (${m.slice(0, 200)}). Nothing was paid.`);
  }
  let settled: { transaction?: string; network?: string } | undefined;
  try {
    settled = new x402HTTPClient(client).getPaymentSettleResponse((name) => r.headers.get(name)) as typeof settled;
  } catch {
    settled = undefined;
  }
  const transaction = settled?.transaction ?? null;
  let text: string;
  try {
    text = await r.text();
  } catch (e) {
    console.error("[privacybuddy] reading the answer failed", { signed, status: r.status, error: e });
    if (signed) return { error: AFTER_APPROVAL, status: 502, transaction };
    throw new Error("The answer could not be read. Nothing was paid.");
  }
  const result = readAnswer(r.status, text, (name) => r.headers.get(name), settled, net.name);
  if (!("error" in result)) return result;
  if (signed && r.status >= 500 && /not charged/i.test(result.error)) return { error: AFTER_APPROVAL, status: r.status, transaction };
  // A failure that came with a receipt shows it, so the visitor can check the payment.
  return transaction && !result.transaction ? { ...result, transaction } : result;
}
