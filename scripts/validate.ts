/**
 * Milestone 4 gate: validation suite.
 *
 * Runs the compiled orchestrator (`dist/index.js`) as a subprocess in a series
 * of controlled scenarios. Telegram is short-circuited via TELEGRAM_DRY_RUN=1
 * so this script can be re-run freely without spamming the chat.
 *
 * Coverage:
 *   T1  First run notifies + writes state.
 *   T2  No-change run is silent (no notify, no snapshot rewrite).
 *   T3  Mutated fragmentHash on disk → next run alerts as a "change".
 *   T4  Bad URL increments consecutiveFailures and does NOT notify.
 *   T5  Bad URL hitting FAILURE_ALERT_THRESHOLD fires exactly one alert.
 *
 * Manual checks (documented in README, not scripted here): wifi off mid-fetch,
 * 20 consecutive runs over an hour against the real site.
 *
 * Exits 0 if all tests pass, 1 otherwise.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const ENTRY = join(REPO_ROOT, "dist", "index.js");

if (!existsSync(ENTRY)) {
  console.error(`Compiled entry not found at ${ENTRY}. Run 'npm run build' first.`);
  process.exit(1);
}

const folio = process.env.TRAMITE_FOLIO;
const email = process.env.TRAMITE_EMAIL;
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!folio || !email || !token || !chatId) {
  console.error("Need TRAMITE_FOLIO, TRAMITE_EMAIL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID in .env.");
  process.exit(1);
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  stateFile: string;
  badUrl?: boolean;
  failureThreshold?: number;
}

function runWatcher(opts: RunOptions): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TELEGRAM_BOT_TOKEN: token!,
    TELEGRAM_CHAT_ID: chatId!,
    TRAMITE_FOLIO: folio!,
    TRAMITE_EMAIL: email!,
    STATE_FILE: opts.stateFile,
    FAILURE_ALERT_THRESHOLD: String(opts.failureThreshold ?? 6),
    TELEGRAM_DRY_RUN: "1",
  };
  if (opts.badUrl) {
    // 127.0.0.1:1 — port 1 is reserved/typically refused, fast deterministic failure.
    env.TRAMITE_URL = "http://127.0.0.1:1/sfpya-bogus";
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY], { env, cwd: REPO_ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

interface SnapshotShape {
  statusText: string;
  fragmentHash: string;
  fetchedAt: string;
}

interface StateShape {
  lastSnapshot: SnapshotShape | null;
  consecutiveFailures: number;
  done: boolean;
}

function readJsonState(path: string): StateShape | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as StateShape;
}

function writeJsonState(path: string, s: StateShape): void {
  writeFileSync(path, JSON.stringify(s, null, 2) + "\n", "utf8");
}

class TestFail extends Error {}
function expect(cond: boolean, msg: string): void {
  if (!cond) throw new TestFail(msg);
}

interface Test {
  name: string;
  run: (workDir: string) => Promise<void>;
}

const tests: Test[] = [
  {
    name: "T1  first run: writes state and notifies",
    run: async (workDir) => {
      const stateFile = join(workDir, "t1.json");
      const r = await runWatcher({ stateFile });
      expect(r.exitCode === 0, `exit ${r.exitCode}; stderr=${r.stderr.slice(0, 300)}`);
      expect(r.stdout.includes("[DRY RUN]"), "expected dry-run notify in stdout");
      expect(r.stdout.includes("iniciado"), "expected 'iniciado' message");
      const state = readJsonState(stateFile);
      expect(state !== null, "state file should exist after first run");
      expect(state!.lastSnapshot !== null, "lastSnapshot should be populated");
      expect(/^[0-9a-f]{64}$/.test(state!.lastSnapshot!.fragmentHash), "fragmentHash should be 64-hex");
      expect(state!.consecutiveFailures === 0, "failures should be 0");
      expect(state!.done === false, "done should be false");
    },
  },
  {
    name: "T2  no-change run: silent, no notify",
    run: async (workDir) => {
      const stateFile = join(workDir, "t2.json");
      // Seed with current snapshot via a real first run.
      const seed = await runWatcher({ stateFile });
      expect(seed.exitCode === 0, "seed run failed");
      const before = readJsonState(stateFile)!;
      const r = await runWatcher({ stateFile });
      expect(r.exitCode === 0, `exit ${r.exitCode}`);
      expect(!r.stdout.includes("[DRY RUN]"), "should NOT notify on no-change run");
      expect(r.stdout.includes("Sin cambios"), "expected 'Sin cambios' log line");
      const after = readJsonState(stateFile)!;
      expect(after.lastSnapshot!.fragmentHash === before.lastSnapshot!.fragmentHash, "hash should be unchanged");
    },
  },
  {
    name: "T3  mutated fragmentHash on disk: next run alerts as change",
    run: async (workDir) => {
      const stateFile = join(workDir, "t3.json");
      // Seed first.
      const seed = await runWatcher({ stateFile });
      expect(seed.exitCode === 0, "seed run failed");
      const seeded = readJsonState(stateFile)!;
      // Mutate hash to a clearly-bogus value.
      const fakeHash = "0".repeat(64);
      writeJsonState(stateFile, {
        ...seeded,
        lastSnapshot: { ...seeded.lastSnapshot!, fragmentHash: fakeHash, statusText: "ESTADO ANTERIOR FALSO" },
      });
      const r = await runWatcher({ stateFile });
      expect(r.exitCode === 0, `exit ${r.exitCode}`);
      expect(r.stdout.includes("[DRY RUN]"), "expected dry-run notify");
      expect(r.stdout.includes("Cambio") || r.stdout.includes("Antes:"), "expected change-message wording");
      const after = readJsonState(stateFile)!;
      expect(after.lastSnapshot!.fragmentHash !== fakeHash, "hash should have been overwritten with real one");
    },
  },
  {
    name: "T4  bad URL: increments counter, does NOT notify",
    run: async (workDir) => {
      const stateFile = join(workDir, "t4.json");
      writeJsonState(stateFile, { lastSnapshot: null, consecutiveFailures: 0, done: false });
      const r = await runWatcher({ stateFile, badUrl: true, failureThreshold: 6 });
      expect(r.exitCode === 1, `expected exit 1 on fetch failure, got ${r.exitCode}`);
      expect(!r.stdout.includes("[DRY RUN]"), "should NOT notify below threshold");
      const state = readJsonState(stateFile)!;
      expect(state.consecutiveFailures === 1, `expected counter=1, got ${state.consecutiveFailures}`);
      expect(state.lastSnapshot === null, "lastSnapshot should not be written on failure");
    },
  },
  {
    name: "T5  bad URL at threshold: alert fires exactly once",
    run: async (workDir) => {
      const stateFile = join(workDir, "t5.json");
      const threshold = 3;
      // Pre-seed state at threshold-1; next failure crosses it.
      writeJsonState(stateFile, {
        lastSnapshot: null,
        consecutiveFailures: threshold - 1,
        done: false,
      });
      const cross = await runWatcher({ stateFile, badUrl: true, failureThreshold: threshold });
      expect(cross.exitCode === 1, `cross run exit ${cross.exitCode}`);
      expect(cross.stdout.includes("[DRY RUN]"), "expected threshold alert via dry-run");
      expect(cross.stdout.includes("fallos consecutivos"), "expected failure-alert wording");
      const after1 = readJsonState(stateFile)!;
      expect(after1.consecutiveFailures === threshold, `counter should be ${threshold}, got ${after1.consecutiveFailures}`);

      // Run again still failing → should NOT re-alert (counter > threshold).
      const again = await runWatcher({ stateFile, badUrl: true, failureThreshold: threshold });
      expect(again.exitCode === 1, "second failure should still exit 1");
      expect(!again.stdout.includes("[DRY RUN]"), "should NOT re-alert past threshold");
      const after2 = readJsonState(stateFile)!;
      expect(after2.consecutiveFailures === threshold + 1, "counter should keep incrementing");
    },
  },
];

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "tramite-validate-"));
  console.log(`workdir: ${workDir}`);

  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    process.stdout.write(`  ${t.name} ... `);
    try {
      await t.run(workDir);
      console.log("PASS");
      passed++;
    } catch (err) {
      const msg = err instanceof TestFail ? err.message : err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.log(`FAIL\n     ${msg}`);
      failed++;
    }
  }

  rmSync(workDir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
