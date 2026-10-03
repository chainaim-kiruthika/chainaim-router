/**
 * Builds PrivacyBuddy for Vercel in its Build Output API format
 * (.vercel/output), which Vercel deploys as it is: the page, wallet.js and
 * client-mask.js and the cookie policy as static files, and /api/wallets and /api/chat as Node
 * functions running src/vercel-api.ts. vercel.json runs this as the build
 * command. Run locally: npm run build:vercel
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SECURITY_HEADERS } from "../src/app.ts";
import { browserMaskModule } from "../src/mask.ts";

const root = new URL("../", import.meta.url);
const API_ROUTES = ["wallets", "chat"];
/** Above the relay's 240 s timeout; needs Vercel's Fluid Compute (the default for new projects). */
const MAX_DURATION_S = 300;

const path = (url: URL) => fileURLToPath(url);

export async function buildVercel(outDir: URL = new URL(".vercel/output/", root)): Promise<void> {
  rmSync(outDir, { recursive: true, force: true });
  const staticDir = new URL("static/", outDir);
  mkdirSync(staticDir, { recursive: true });
  copyFileSync(new URL("public/index.html", root), new URL("index.html", staticDir));
  copyFileSync(new URL("public/cookies.html", root), new URL("cookies.html", staticDir));
  copyFileSync(new URL("public/wallet.js", root), new URL("wallet.js", staticDir));
  writeFileSync(new URL("client-mask.js", staticDir), browserMaskModule());

  const { build } = await import("esbuild");
  const bundled = await build({
    entryPoints: [path(new URL("src/vercel-api.ts", root))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    // Some bundled CommonJS code calls require(); give the ES module one.
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    logLevel: "warning",
  });
  const code = bundled.outputFiles[0].text;
  for (const name of API_ROUTES) {
    const dir = new URL(`functions/api/${name}.func/`, outDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(new URL("index.mjs", dir), code);
    const vc = { runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, maxDuration: MAX_DURATION_S };
    writeFileSync(new URL(".vc-config.json", dir), JSON.stringify(vc, null, 2));
  }

  const config = { version: 3, routes: [{ src: "/(.*)", headers: SECURITY_HEADERS, continue: true }, { handle: "filesystem" }] };
  writeFileSync(new URL("config.json", outDir), JSON.stringify(config, null, 2));
  console.log(`[build-vercel] wrote ${path(outDir)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildVercel();
