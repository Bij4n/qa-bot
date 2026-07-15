# QA-Bot

AI-driven QA agent for web applications. An AI agent (your Claude Code session)
drives a real browser through your app — frontend flows and backend APIs — and
produces a per-session report with a health score, severity-ranked findings,
repro steps, full-page screenshots, and screen recordings of every test phase.

Two pieces:

- **`qab`** — a fast multi-browser CLI. A background daemon keeps a Playwright
  browser warm, so every command (navigate, click, screenshot, API check) is a
  ~100ms localhost call. Engines: **Chromium, Chrome, Firefox** on
  **Linux, Windows, and macOS**.
- **The `qa-bot` skill** — the QA methodology prompt that turns a Claude Code
  session into the QA engineer: what to test, how to classify severity, how to
  score health, and the exact report format.

## Install

Requires [Node.js](https://nodejs.org) 20+.

```bash
git clone <this-repo> && cd QA-Bot
npm install
npx playwright install chromium firefox   # downloads the browser engines
npm run build
npm link                                  # puts `qab` on your PATH
```

`qab engine chrome` additionally requires Google Chrome installed on the machine
(it drives your real Chrome instead of bundled Chromium).

### Register the skill (Claude Code)

Copy or symlink the skill directory so Claude Code discovers it:

```bash
# macOS / Linux
ln -s "$(pwd)/skill" ~/.claude/skills/qa-bot

# Windows (PowerShell)
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\qa-bot" -Target "$(Get-Location)\skill"
```

Then in any Claude Code session:

```
/qa-bot test http://localhost:3000
```

## What a session produces

Sessions are organized by test phase — frontend (desktop), mobile, and
backend/API — with everything routed automatically:

```
reports/2026-07-15-14-30-myapp/
├── report.md                        # health score, findings by severity, repro steps
├── frontend/                        # desktop pass — full-page screenshots
│   ├── 01-home.png
│   └── 02-bug-checkout-500.png
├── mobile/                          # mobile pass (375x812)
│   └── 01-home.png
├── backend/
│   └── api-log.jsonl                # every API call: status, latency, body preview
└── recordings/                      # screen recordings, per phase per engine
    ├── frontend-chromium.webm
    ├── mobile-chromium.webm
    └── frontend-firefox.webm
```

`qab phase frontend|mobile|backend` switches phases: it finalizes the current
phase's screen recording, starts a new one at the right viewport, and routes
subsequent screenshots to that phase's folder. `qab api` calls are logged to
`backend/api-log.jsonl` automatically during a session.

Findings follow a strict format — severity (Critical / High / Medium /
Cosmetic), affected area, numbered repro steps, expected vs actual, and
photographic evidence. The health score starts at 10 and deducts per finding.

## Using `qab` directly

```bash
qab session start myapp        # begin a session → reports/<ts>-myapp/ (recording starts)
qab goto http://localhost:3000 # navigate; reports console errors + failed requests
qab snapshot                   # accessibility-tree view of the page
qab click "text=Sign up"       # css / text= / role= selectors
qab fill "#email" user@test.dev
qab shot signup-page           # full-page screenshot → frontend/
qab phase mobile               # finalize frontend video, record mobile at 375x812
qab shot signup-page           # → mobile/
qab phase backend              # finalize mobile video, start backend phase
qab api POST http://localhost:3000/api/users '{"email":""}'   # → backend/api-log.jsonl
qab network failed             # every failed request captured so far
qab engine firefox             # switch engines (recordings are per phase, per engine)
qab session end                # finalize the last recording, list all recordings
qab stop                       # shut the daemon down
```

Run `qab help` for the full command list. Daemon state lives in `~/.qa-bot/`
(log: `~/.qa-bot/daemon.log`).

## Platform notes

| | Chromium | Chrome | Firefox |
|---|---|---|---|
| Linux | ✅ bundled | ✅ if installed | ✅ bundled |
| macOS | ✅ bundled | ✅ if installed | ✅ bundled |
| Windows | ✅ bundled | ✅ if installed | ✅ bundled |

On Linux CI or fresh servers, install system dependencies with
`npx playwright install --with-deps chromium firefox`.
