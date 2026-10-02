/**
 * Turns the /api/chat response into what the page shows: the answer with its
 * model, data class and receipt, or one plain sentence saying what went wrong.
 * Pure, so Node tests it and the browser bundle uses the same code.
 */
export type Answer = { answer: string; model: string | null; dataClass: string | null; payment: { transaction: string | null; network: string | null } };
/** transaction: the receipt, when the payment settled but the answer was lost. */
export type Failure = { error: string; status: number; transaction?: string | null };

const NETWORK_LABEL: Record<string, string> = { mainnet: "MainNet", testnet: "TestNet" };

/** The paywall's reason for refusing a payment: the `error` in its base64 Payment-Required header. The bare "Payment required" is no reason. */
function refusalReason(header: (name: string) => string | null): string | undefined {
  const raw = header("payment-required");
  if (!raw) return undefined;
  try {
    const e = (JSON.parse(atob(raw)) as { error?: unknown }).error;
    if (typeof e !== "string") return undefined;
    const reason = e.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
    return reason && reason !== "Payment required" ? reason : undefined;
  } catch {
    return undefined;
  }
}

function explain(status: number, text: string, header: (name: string) => string | null, network: string | undefined): string {
  if (status === 402) {
    const reason = refusalReason(header);
    const where = network ? NETWORK_LABEL[network] : undefined;
    return `The payment was not accepted${reason ? ` (${reason})` : ""}. Check that your wallet holds USDC${where ? ` on ${where}` : ""} and has opted in to it. You were not charged.`;
  }
  try {
    const m = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    if (typeof m === "string" && m) return m.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return `The chat service failed (HTTP ${status}). You were not charged.`;
}

export function readAnswer(
  status: number,
  text: string,
  header: (name: string) => string | null,
  settled: { transaction?: string; network?: string } | undefined,
  network?: string,
): Answer | Failure {
  if (status < 200 || status >= 300) return { error: explain(status, text, header, network), status };
  let answer: unknown;
  try {
    answer = (JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  } catch {
    answer = undefined;
  }
  if (typeof answer !== "string") {
    return { error: "The model's answer could not be read. Check the payment receipt before trying again.", status: 502, transaction: settled?.transaction ?? null };
  }
  return {
    answer,
    model: header("x-chainaim-model"),
    dataClass: header("x-chainaim-data-class"),
    payment: { transaction: settled?.transaction ?? null, network: settled?.network ?? null },
  };
}
