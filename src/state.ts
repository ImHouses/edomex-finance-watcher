import { readFile, writeFile, rename } from "node:fs/promises";
import type { TramiteSnapshot } from "./fetcher/index.js";

export interface State {
  lastSnapshot: TramiteSnapshot | null;
  consecutiveFailures: number;
  done: boolean;
}

const EMPTY_STATE: State = {
  lastSnapshot: null,
  consecutiveFailures: 0,
  done: false,
};

export async function readState(path: string): Promise<State> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return { ...EMPTY_STATE };
    throw err;
  }

  const parsed = JSON.parse(raw) as Partial<State>;
  return {
    lastSnapshot: parsed.lastSnapshot ?? null,
    consecutiveFailures: parsed.consecutiveFailures ?? 0,
    done: parsed.done ?? false,
  };
}

export async function writeState(path: string, s: State): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}`;
  const body = JSON.stringify(s, null, 2) + "\n";
  await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
