# tramite-watcher

Polls a single SFPYA Edomex trámite (`#-folio`) on a 30-minute systemd timer and sends a Telegram notification when its status changes.

See `CLAUDE.md` for the full technical brief and milestone plan.

## Quick start (local dev)

```sh
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID once available
npm install
npm run dev
```

## Scripts

| Command                | Purpose                                          |
| ---------------------- | ------------------------------------------------ |
| `npm run dev`          | Single run via `tsx` (reads `.env`).             |
| `npm start`            | Compiled single run (what systemd invokes).     |
| `npm run build`        | TypeScript build to `dist/`.                     |
| `npm run test:fetcher` | M2 gate: 10-call consistency check.              |
| `npm run validate`     | M4 gate: full validation suite.                  |

## Validation

`npm run validate` runs an automated suite that exercises the orchestrator's branches against the live SFPYA site. Telegram is short-circuited via `TELEGRAM_DRY_RUN=1` so re-runs don't spam the chat. Each pass makes ~5 real fetches; rerun freely.

Coverage:

| # | Scenario | Asserts |
| - | - | - |
| T1 | First run | exit 0, state written, "iniciado" notify |
| T2 | Second run unchanged | exit 0, no notify, hash unchanged |
| T3 | Mutated `fragmentHash` on disk | exit 0, change notify, hash overwritten |
| T4 | Bad URL (1 run) | exit 1, counter=1, no notify |
| T5 | Bad URL crossing `FAILURE_ALERT_THRESHOLD` | exit 1, alert fires once at threshold and not again |

### Manual checks (before deploy)

These don't fit a script and need to be done by hand:

1. **Wifi off mid-fetch.** Disconnect, run `npm start`, reconnect. Expect: clean error, exit 1, `consecutiveFailures` incremented, `lastSnapshot` unchanged. No partial state file artefacts (no leftover `state.json.tmp.<pid>`).
2. **20 consecutive runs over ~1 hour against the live site.** Real Telegram tokens, no `TELEGRAM_DRY_RUN`. Run `npm start` every 3 minutes for an hour (or `for i in {1..20}; do npm start; sleep 180; done`). Expect: exactly **one** Telegram message (the "iniciado" from the first run) and zero false-positive change alerts. Any flap means hash normalization is missing something.

## Deployment

Systemd unit files and deploy steps land in Milestone 5.
