import { fetchTramite, type TramiteSnapshot } from "./fetcher/index.js";
import { readState, writeState, type State } from "./state.js";
import { sendTelegram } from "./notify.js";

interface Config {
  telegramToken: string;
  telegramChatId: string;
  folio: string;
  email: string;
  stateFile: string;
  failureAlertThreshold: number;
  terminalStatus: string | null;
}

function loadConfig(): Config {
  const required = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
  };

  const thresholdRaw = process.env.FAILURE_ALERT_THRESHOLD ?? "6";
  const failureAlertThreshold = Number.parseInt(thresholdRaw, 10);
  if (!Number.isFinite(failureAlertThreshold) || failureAlertThreshold < 1) {
    throw new Error(`FAILURE_ALERT_THRESHOLD must be a positive integer, got: ${thresholdRaw}`);
  }

  const terminalStatusRaw = process.env.TERMINAL_STATUS?.trim();
  return {
    telegramToken: required("TELEGRAM_BOT_TOKEN"),
    telegramChatId: required("TELEGRAM_CHAT_ID"),
    folio: required("TRAMITE_FOLIO"),
    email: required("TRAMITE_EMAIL"),
    stateFile: process.env.STATE_FILE ?? "./state.json",
    failureAlertThreshold,
    terminalStatus: terminalStatusRaw && terminalStatusRaw.length > 0 ? terminalStatusRaw : null,
  };
}

async function notify(cfg: Config, text: string): Promise<void> {
  await sendTelegram(cfg.telegramToken, cfg.telegramChatId, text);
}

function formatInitial(snap: TramiteSnapshot, folio: string): string {
  return [
    `tramite-watcher iniciado`,
    `Folio: ${folio}`,
    `Estado actual: ${snap.statusText}`,
    `Consultado: ${snap.fetchedAt}`,
  ].join("\n");
}

function formatChange(prev: TramiteSnapshot, next: TramiteSnapshot, folio: string): string {
  return [
    `Cambio en trámite ${folio}`,
    `Antes: ${prev.statusText}`,
    `Ahora: ${next.statusText}`,
    `Consultado: ${next.fetchedAt}`,
  ].join("\n");
}

function formatTerminal(snap: TramiteSnapshot, folio: string): string {
  return [
    `Trámite ${folio} completado`,
    `Estado final: ${snap.statusText}`,
    `Consultado: ${snap.fetchedAt}`,
  ].join("\n");
}

function formatFailureAlert(threshold: number, errorSummary: string): string {
  return [
    `tramite-watcher: ${threshold} fallos consecutivos`,
    `Último error: ${errorSummary}`,
  ].join("\n");
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const state = await readState(cfg.stateFile);

  if (state.done) {
    console.log("done=true; trámite ya completado, saliendo sin consultar.");
    return 0;
  }

  let snap: TramiteSnapshot;
  try {
    snap = await fetchTramite(cfg.folio, cfg.email);
  } catch (err) {
    return await handleFetchFailure(cfg, state, err);
  }

  // Success path: reset failure counter (saved with new snapshot below).
  const previouslyFailed = state.consecutiveFailures > 0;

  // Terminal-status check beats normal change detection.
  if (cfg.terminalStatus && snap.statusText === cfg.terminalStatus) {
    await notify(cfg, formatTerminal(snap, cfg.folio));
    await writeState(cfg.stateFile, { lastSnapshot: snap, consecutiveFailures: 0, done: true });
    console.log(`Trámite completado ("${snap.statusText}"). Alerta enviada; done=true escrito.`);
    return 0;
  }

  if (state.lastSnapshot === null) {
    await notify(cfg, formatInitial(snap, cfg.folio));
    await writeState(cfg.stateFile, { lastSnapshot: snap, consecutiveFailures: 0, done: false });
    console.log(`Primera ejecución; alerta inicial enviada y estado guardado: "${snap.statusText}".`);
    return 0;
  }

  if (state.lastSnapshot.fragmentHash !== snap.fragmentHash) {
    await notify(cfg, formatChange(state.lastSnapshot, snap, cfg.folio));
    await writeState(cfg.stateFile, { lastSnapshot: snap, consecutiveFailures: 0, done: false });
    console.log(`Cambio detectado: "${state.lastSnapshot.statusText}" → "${snap.statusText}".`);
    return 0;
  }

  // No change. Persist only if we need to clear the failure counter; otherwise
  // skip the write to keep this path side-effect-free on disk.
  if (previouslyFailed) {
    await writeState(cfg.stateFile, { ...state, consecutiveFailures: 0 });
  }
  console.log(`Sin cambios: "${snap.statusText}".`);
  return 0;
}

async function handleFetchFailure(cfg: Config, state: State, err: unknown): Promise<number> {
  const summary = err instanceof Error ? err.message : String(err);
  const failures = state.consecutiveFailures + 1;
  const next: State = { ...state, consecutiveFailures: failures };
  await writeState(cfg.stateFile, next);

  console.error(`Error al consultar trámite (fallo ${failures}): ${summary}`);

  if (failures === cfg.failureAlertThreshold) {
    try {
      await notify(cfg, formatFailureAlert(failures, summary));
    } catch (notifyErr) {
      console.error("También falló el envío de Telegram:", notifyErr);
    }
  }
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error("FATAL:", err);
    process.exit(1);
  },
);
