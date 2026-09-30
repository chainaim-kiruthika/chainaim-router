/**
 * scripts/private-ask.ts without the network: --dry-run masks on this machine
 * and shows the exact request body, which must hold no original value.
 * The paying path needs a funded buyer account; the owner runs it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const cwd = fileURLToPath(new URL("../", import.meta.url));

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/private-ask.ts", ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const PRESCRIPTION = "Patient Name: Jane Roe\nAadhaar 2345 6789 0123\nMRN 991122\nCard 4111 1111 1111 1111\nDiagnosis: diabetes. Rx: metformin 500 mg\n";
const ORIGINALS = ["Jane Roe", "2345 6789 0123", "991122", "4111 1111 1111 1111"];

describe("scripts/private-ask.ts", () => {
  let dir: string;
  let file: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "private-ask-"));
    file = join(dir, "prescription.txt");
    writeFileSync(file, PRESCRIPTION);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  for (const endpoint of ["chat", "scan"]) {
    it(`--dry-run (${endpoint}) sends nothing and its request body holds no original value`, async () => {
      const r = await run(["--dry-run", "--file", file, "--endpoint", endpoint, "--question", "Is Jane Roe on two drugs for the same thing?"]);
      assert.equal(r.code, 0, r.stderr);
      const line = r.stdout.split("\n").find((l) => l.startsWith("request body: "));
      assert.ok(line, r.stdout);
      const body = line.slice("request body: ".length);
      for (const v of ORIGINALS) assert.ok(!body.includes(v), `${v} is in the request body: ${body}`);
      assert.ok(body.includes("<C_PERSON_1>") && body.includes("[CARD REMOVED]") && body.includes("metformin"), body);
      assert.ok(r.stdout.includes("dry run: nothing was sent and nothing was paid"));
      if (endpoint === "chat") assert.ok(JSON.parse(body).messages[0].content.startsWith("Is <C_PERSON_1> on two drugs"), "the question is masked too");
      else assert.deepEqual(Object.keys(JSON.parse(body)), ["text"]);
    });
  }

  it("needs --file, a text file, and --url when not a dry run", async () => {
    assert.equal((await run([])).code, 2);
    const pdf = join(dir, "scan.pdf");
    writeFileSync(pdf, "%PDF");
    const r = await run(["--dry-run", "--file", pdf]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /only \.txt and \.md/);
    const noUrl = await run(["--file", file]);
    assert.equal(noUrl.code, 2);
    assert.match(noUrl.stderr, /--url is required/);
  });

  it("refuses to pay without AVM_MNEMONIC, after masking and before any network call", async () => {
    const r = await run(["--file", file, "--url", "https://pay.example.invalid", "--endpoint", "scan"], { AVM_MNEMONIC: "" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /AVM_MNEMONIC/);
  });
});
