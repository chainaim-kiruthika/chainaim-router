/**
 * V4 check against a running Presidio analyzer: every required entity is
 * supported, and the synthetic corpus gets its expected data class with
 * ChainAim's ad-hoc recognizers. It prints item ids, classes and entity
 * types, never the text.
 *
 *   node scripts/verify-presidio.ts [--url http://127.0.0.1:5002]
 *
 * Exit code 0 = everything as expected.
 */
import { parseArgs } from "node:util";
import { classify } from "../services/gateway/src/privacy/classify.ts";
import { REQUIRED_PRESIDIO_ENTITIES } from "../services/gateway/src/privacy/entities.ts";
import { PresidioClient } from "../services/gateway/src/privacy/presidio.ts";
import { CORPUS } from "./synthetic-corpus.ts";

export async function verifyPresidio(url: string): Promise<{ ok: boolean; lines: string[] }> {
  const client = new PresidioClient({ url, threshold: 0.4, timeoutMs: 30_000 });
  const supported = new Set(await client.supportedEntities());
  const missing = REQUIRED_PRESIDIO_ENTITIES.filter((e) => !supported.has(e));
  let ok = missing.length === 0;
  const lines = [missing.length > 0 ? `FAIL missing entities: ${missing.join(", ")}` : `ok   all ${REQUIRED_PRESIDIO_ENTITIES.length} required entities are supported`];
  for (const item of CORPUS) {
    const found = await client.analyze(item.text);
    const { dataClass } = classify(found.map((e) => e.type));
    const pass = dataClass === item.expect.dataClass;
    ok &&= pass;
    const types = [...new Set(found.map((e) => e.type))].join(",") || "-";
    lines.push(`${pass ? "ok  " : "FAIL"} ${item.id.padEnd(12)} dataClass=${dataClass} (want ${item.expect.dataClass}) types=${types}`);
  }
  return { ok, lines };
}

if (import.meta.main ?? process.argv[1]?.endsWith("verify-presidio.ts")) {
  const { values } = parseArgs({ options: { url: { type: "string", default: "http://127.0.0.1:5002" } } });
  const { ok, lines } = await verifyPresidio(values.url!);
  for (const line of lines) console.log(line);
  process.exitCode = ok ? 0 : 1;
}
