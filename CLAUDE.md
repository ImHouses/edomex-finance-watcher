# CLAUDE.md — tramite-watcher

## Mission

Build a polling tool that monitors a single SFPYA Edomex trámite (folio `AVN-19252347-2026`) and sends a Telegram notification when its status changes. Runs as a systemd timer on a personal VPS.

## Status

- **Phase 1 (Telegram bot setup):** handled by user, not your concern. The user will populate `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env` before deploy. Your code reads these from env; placeholder values are fine during local dev.
- **Phase 2 onward:** that's you. Start at Phase 2 (Milestone 2 below).

## Tech stack — decisions made, do not relitigate

- Node 20+, TypeScript (strict), ES modules.
- Runtime deps: `dotenv` only. Use native `fetch` and `crypto.subtle`.
- HTML parsing: `node-html-parser` (lightweight). Don't reach for `jsdom`.
- XML parsing: regex extraction is fine — we only need one CDATA block. If you prefer a parser, use `node-html-parser` again or `fast-xml-parser`. Document which.
- Dev: `tsx`. Build: `tsc`. No bundler.
- No test framework — a few `npm run test:*` scripts that exit non-zero on failure are sufficient.

## The fetcher — technical brief

The site is a JSF / PrimeFaces app. A naive single-request fetch will not work. Two-step flow per poll:

### Step 1: GET the form page

```
GET https://sfpya.edomexico.gob.mx/controlv/faces/tramiteselectronicos/cv/portalPublico/consultaTramite.xhtml
```

Capture every `Set-Cookie` from the response. At minimum: `JSESSIONID`, `BIGipServerPool.gemweb_N`, and any `__uzm*` / `uzmx` Incapsula cookies. Parse the response HTML to extract:

- **`javax.faces.ViewState`** — value of the hidden input with that name.
- **Form prefix** — find the input whose `name` ends in `:folio`. Take everything before that final segment (e.g. `j_idt29:j_idt32:j_idt33`). Use this prefix to build the submit-button id, the `javax.faces.source` value, and the render target. Also extract the outer form id (the first segment of the prefix, e.g. `j_idt29`).

**Do not hardcode any `j_idtN` value.** They renumber on JSF redeploys; parsing them is the only way this stays alive long-term.

### Step 2: POST the form

Same URL as Step 1.

Headers — replicate the browser:
- `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`
- `Accept: application/xml, text/xml, */*; q=0.01`
- `Faces-Request: partial/ajax`
- `X-Requested-With: XMLHttpRequest`
- `Origin: https://sfpya.edomexico.gob.mx`
- `Referer: <same as URL>`
- `User-Agent`: realistic Chrome string.
- All cookies from Step 1.

Body (URL-encoded):
- `javax.faces.partial.ajax=true`
- `javax.faces.source=<prefix>:<button-id>`
- `javax.faces.partial.execute=@all`
- `javax.faces.partial.render=<prefix>:datos`
- `<prefix>:<button-id>=<prefix>:<button-id>` (yes, repeated)
- `<form-id>=<form-id>`
- `<prefix>:folio=<FOLIO>`
- `<prefix>:codigoSeguridad=<EMAIL>` — the field is named `codigoSeguridad` but the value is the email associated with the trámite. Not a typo.
- `javax.faces.ViewState=<value from Step 1>`

### Step 3: Parse the response

The response is JSF partial-response XML. **Empirically (M2), the server ignores our `partial.render=:datos` and returns a full `<update id="javax.faces.ViewRoot">`** with the entire results page embedded:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<partial-response>
  <changes>
    <update id="javax.faces.ViewRoot"><![CDATA[ ...full results HTML... ]]></update>
    <update id="j_id1:javax.faces.ViewState:0"><![CDATA[ ...new viewstate... ]]></update>
  </changes>
</partial-response>
```

Code defensively: try `<update id="<prefix>:datos">` first, then fall back to `javax.faces.ViewRoot`. Either way, **do not hash the raw update payload** — ViewRoot is enormous and includes rotating ids/scripts.

Inside the payload, the trámite data lives in one or more `<div class="panelDatos">` blocks. The fetcher concatenates every `.panelDatos` subtree (the page renders several: one for vehicle info — CLASE/MARCA/MODELO/AÑO/LINEA — and one for trámite info — FOLIO/ESTATUS/TRÁMITE/FECHA/OBSERVACIONES). That joined HTML, whitespace-normalized, is what we hash.

Each row inside a panel is a pair of `<label>` elements: the first holds the field name (e.g. `<label>ESTATUS:</label>`), the next `<label>` in document order holds the value (e.g. `<label>En proceso de revisión</label>`). The status extractor walks labels in pairs.

Ship the status regex with a `// REFINE` comment — it's tuned to the markup observed on M2; a future PrimeFaces theme/template change will probably require widening it.

### Reference

The user will save the real browser cURL at `docs/sample-request.curl`. Treat that file as the wire-format ground truth when wiring up Step 2. If it's missing, ask before guessing.

## File layout

```
src/
  index.ts          orchestrator
  fetcher/
    get.ts          Step 1: GET + parse ViewState/prefix
    post.ts         Step 2: POST + parse XML envelope
    extract.ts      pull status text from the :datos fragment
    index.ts        public fetchTramite() composing the above
  state.ts          read/write state.json
  notify.ts         Telegram sendMessage wrapper
systemd/
  tramite-watcher.service
  tramite-watcher.timer
docs/
  sample-request.curl    (provided by user)
.env.example
package.json
tsconfig.json
README.md
```

## Public contracts

```ts
// src/fetcher/index.ts
export interface TramiteSnapshot {
  statusText: string;     // human-readable, e.g. "En proceso de revisión"
  fragmentHash: string;   // SHA-256 (hex) of the normalized :datos fragment
  fetchedAt: string;      // ISO 8601
}

export async function fetchTramite(
  folio: string,
  email: string,
): Promise<TramiteSnapshot>;
```

```ts
// src/state.ts
export interface State {
  lastSnapshot: TramiteSnapshot | null;
  consecutiveFailures: number;
  done: boolean;
}

export async function readState(path: string): Promise<State>;
export async function writeState(path: string, s: State): Promise<void>;
```

Implementation notes: `readState` returns an empty default (`{ lastSnapshot: null, consecutiveFailures: 0, done: false }`) when the file is absent (ENOENT). `writeState` does an atomic write — write to `${path}.tmp.${pid}` then `rename` — so a crash mid-write can't leave a half-written state file.

Orchestrator ordering: in the M3 success paths (initial run, change detected, terminal status), `index.ts` calls `notify()` first and `writeState()` after. If Telegram is transiently down, the next run still sees the old snapshot and re-attempts the alert. If Telegram succeeds but state-write fails (rare — local disk), the next run sends a duplicate alert; that's annoying but strictly safer than silently dropping a notification.

```ts
// src/notify.ts
export async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<void>;
```

## Environment variables

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TRAMITE_FOLIO=AVN-19252347-2026
TRAMITE_EMAIL=imhouses19@gmail.com
STATE_FILE=./state.json
FAILURE_ALERT_THRESHOLD=6
TERMINAL_STATUS=                    # leave empty; user fills once known
```

## Milestones — work through in order

### Milestone 2 — JSF fetcher, validated standalone ✅

Acceptance criteria:
- `fetchTramite(folio, email)` returns a `TramiteSnapshot` with non-empty `statusText` and a 64-char hex `fragmentHash`.
- A `npm run test:fetcher` script calls it 10 times back-to-back and asserts that `statusText` and `fragmentHash` are identical across all 10 calls. Exits 0 on PASS, non-zero on FAIL.
- Script also prints the joined `panelDatos` fragment on the first call so the user can use it to refine the status regex.

Outcome: green. 10/10 identical calls; statusText `"En proceso de revisión"`; fragment hash stable (~330–560 ms/call).

### Milestone 3 — diff + state + notify glue ✅

Acceptance criteria:
- `npm start` reads state, fetches, hashes, diffs, sends Telegram on change, writes state.
- First run (no state.json): sends an "iniciado" message with the initial status, writes state.
- Subsequent run, no change: exits silent (a single log line). Skips state write unless clearing a non-zero failure counter.
- Subsequent run, status changed: sends a Telegram message containing the previous and new `statusText`, writes new state.
- On fetch exception: increments `consecutiveFailures` in state, does not write a new snapshot. Alerts via Telegram only when the counter equals `FAILURE_ALERT_THRESHOLD` (one alert per crossing). Resets to 0 on next success.
- On notify exception (after a successful fetch): exits non-zero without writing state. The next run sees the same state and retries the alert. The `consecutiveFailures` counter is reserved for fetch-side failures only — Telegram-side outages don't trip the threshold alert (the alert path is also Telegram, so counting them would not help).
- If `statusText` equals `TERMINAL_STATUS` (when that env var is set): sends a completion message and writes `done: true`. Any subsequent run with `done: true` exits immediately without fetching.

Outcome: green. Verified against the real site that the orchestrator routes correctly to the initial-run branch, calls `notify()` before `writeState()`, and leaves state untouched when Telegram fails. Full bad-URL / wifi-off / mutated-state coverage is M4's responsibility.

### Milestone 4 — local validation ✅ (script) / pending (manual)

`npm run validate` covers, scripted:
- First run writes state and notifies (T1).
- Second run unchanged → silent (T2).
- Mutating `state.json`'s `fragmentHash` by hand → next run alerts (T3).
- Pointing at a deliberately bad URL → failure counter increments, no false notification (T4).
- Bad URL crossing `FAILURE_ALERT_THRESHOLD` → alert fires once (T5).

To enable the script, two env hooks were added:
- `TRAMITE_URL` — overrides the default endpoint. Used by T4/T5 to simulate connection failure (`http://127.0.0.1:1/...`).
- `TELEGRAM_DRY_RUN=1` — short-circuits `sendTelegram` to log instead of POST. Default for the validation suite so it can be re-run without spamming Telegram.

Manual (documented in README, not yet exercised on this machine):
- Wifi off mid-fetch → errors cleanly, no partial state written.
- 20 consecutive runs over an hour against the real site → zero false-positive notifications.

### Milestone 5 — VPS deployment artifacts

- `systemd/tramite-watcher.service`: `Type=oneshot`, dedicated `tramite` system user, `EnvironmentFile`, hardening (`NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=/opt/tramite-watcher`).
- `systemd/tramite-watcher.timer`: 30-minute cadence, `Persistent=true`, `OnBootSec=2min`.
- README section with copy-pasteable deploy commands: useradd, rsync, npm ci, tsc, cp units, systemctl enable.

Don't generate a companion sanity-check timer unless the user asks for it.

## Things to avoid

- **Don't hardcode `j_idt29` or any auto-generated component id.** Parse from GET response.
- **Don't hash the full POST response.** Hash only the `:datos` CDATA contents.
- **Don't drop cookies between Step 1 and Step 2.** Carry every `Set-Cookie`. The Incapsula `__uzm*` cookies are bot-detection.
- **Don't use Playwright or any headless browser.** HTTP is sufficient.
- **Don't add fancy Telegram formatting** (inline keyboards, HTML mode, photos). Plain Markdown is enough.
- **Don't alert on every transient failure.** Use the consecutive-failures counter. gob.mx sites flap.
- **Don't expand scope.** No metrics endpoint, no admin web UI, no database, no Docker, no CI config. If something feels missing, leave a `// TODO(juan)` comment.

## Run modes

```
npm run dev               # tsx, single run, reads .env
npm start                 # compiled, single run (this is what systemd invokes)
npm run test:fetcher      # 10-call consistency check (Milestone 2 gate)
npm run validate          # full validation suite (Milestone 4 gate)
npm run build             # tsc
```

## When to ask the user

- **Before starting:** confirm scope matches this document. If you'd change anything, raise it first.
- **End of Milestone 2:** paste the printed `:datos` fragment so the status regex can be refined.
- **End of Milestone 4:** ask whether they'll deploy manually or want you to walk them through it.
- **Any time you're tempted to add scope** that isn't in this doc: ask first.