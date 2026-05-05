/**
 * Milestone 2 gate.
 *
 * Calls fetchTramite() 10 times back-to-back and asserts that statusText and
 * fragmentHash are identical across all calls. Prints the raw :datos fragment
 * from the first call so the status regex in extract.ts can be tuned.
 *
 * Exits 0 on PASS, 1 on FAIL.
 */

import { fetchTramite, extractDataPanel } from "../src/fetcher/index.js";
import { fetchFormPage } from "../src/fetcher/get.js";
import { postTramite } from "../src/fetcher/post.js";

const ITERATIONS = 10;
const folio = process.env.TRAMITE_FOLIO;
const email = process.env.TRAMITE_EMAIL;

if (!folio || !email) {
  console.error("TRAMITE_FOLIO and TRAMITE_EMAIL must be set in .env");
  process.exit(1);
}

async function printFirstFragment(): Promise<void> {
  const page = await fetchFormPage();
  const { updateId, payload } = await postTramite(page, folio!, email!);
  const panel = extractDataPanel(payload);
  console.log(`\n========== panelDatos (first call) — server returned <update id="${updateId}"> ==========`);
  console.log(panel ?? "(panelDatos not found — printing raw payload below)");
  if (!panel) {
    console.log("---raw payload---");
    console.log(payload);
  }
  console.log("========== end fragment ==========\n");
}

async function main(): Promise<void> {
  await printFirstFragment();

  const snapshots = [];
  for (let i = 1; i <= ITERATIONS; i++) {
    const t0 = Date.now();
    const snap = await fetchTramite(folio!, email!);
    const ms = Date.now() - t0;
    console.log(
      `[${i}/${ITERATIONS}] ${ms}ms  hash=${snap.fragmentHash.slice(0, 12)}…  status="${snap.statusText}"`,
    );
    snapshots.push(snap);
  }

  const first = snapshots[0]!;
  const hashMismatch = snapshots.find((s) => s.fragmentHash !== first.fragmentHash);
  const statusMismatch = snapshots.find((s) => s.statusText !== first.statusText);

  if (hashMismatch || statusMismatch) {
    console.error("\nFAIL: snapshots diverged across calls.");
    if (hashMismatch) {
      console.error(`  fragmentHash flapped: ${first.fragmentHash} vs ${hashMismatch.fragmentHash}`);
    }
    if (statusMismatch) {
      console.error(`  statusText flapped: "${first.statusText}" vs "${statusMismatch.statusText}"`);
    }
    process.exit(1);
  }

  console.log(`\nPASS: ${ITERATIONS} consecutive snapshots are identical.`);
  console.log(`  statusText:   ${first.statusText}`);
  console.log(`  fragmentHash: ${first.fragmentHash}`);
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
