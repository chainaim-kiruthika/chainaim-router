/**
 * The one place that knows where client-mask.ts lives. The browser gets the
 * same source, converted to JavaScript by Node's own type stripping (no build
 * step); the server uses `detect` from it for the same self-check as
 * scripts/private-ask.ts.
 */
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

export { detect } from "../../paywall/scripts/client-mask.ts";

const SOURCE = new URL("../../paywall/scripts/client-mask.ts", import.meta.url);

/** client-mask.ts as a JavaScript module a browser can import. */
export function browserMaskModule(): string {
  return stripTypeScriptTypes(readFileSync(SOURCE, "utf8"));
}
