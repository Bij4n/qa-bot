# QA-Bot

QA agent for web apps. It hooks into Claude Code as a skill: you type
`/qa-bot test http://localhost:3000`, the agent drives a real browser through
the app, pokes at forms, checks the mobile layout, hits the API directly, and
leaves behind a report folder with screenshots, screen recordings and a log of
every API call it made.

There's no test script to write or maintain. The agent decides what to test
the same way a QA engineer would, and the `qab` CLI gives it fast hands on a
real browser. Chromium, Chrome and Firefox, on Linux, macOS and Windows.

## Requirements

- Node 20+
- Claude Code
- Google Chrome, if you want to test against real Chrome (`qab engine chrome`).
  Chromium and Firefox come bundled through Playwright, nothing to install.

## Setup

```bash
git clone https://github.com/Bij4n/QA-Bot.git
cd QA-Bot
npm install
npx playwright install chromium firefox
npm run build
npm link          # puts `qab` on your PATH
```

On a fresh Linux box you may need the browser system deps as well:
`npx playwright install --with-deps chromium firefox`.

Then register the skill so Claude Code picks it up:

```bash
# macOS / Linux
ln -s "$(pwd)/skill" ~/.claude/skills/qa-bot
```

```powershell
# Windows
New-Item -ItemType Junction -Path "$env:USERPROFILE\.claude\skills\qa-bot" -Target "$(Get-Location)\skill"
```

That's the whole install. Open Claude Code in whatever project you want
tested and run:

```
/qa-bot test http://localhost:3000
```

The agent will ask how deep to go (quick / standard / exhaustive), work
through the app, and hand you the report path when it's done.

## What a session gives you

Every run creates a folder under `reports/` in the project you ran it from,
organized by what was being tested:

```
reports/2026-07-15-14-30-myapp/
├── report.md                  health score, findings by severity, repro steps
├── frontend/                  desktop screenshots, numbered in test order
├── mobile/                    mobile layout screenshots (375x812)
├── backend/
│   └── api-log.jsonl          every API call: status, latency, body preview
└── recordings/
    ├── frontend-chromium.webm one screen recording per phase, per engine
    ├── mobile-chromium.webm
    └── frontend-firefox.webm
```

`report.md` scores the app out of 10 and ranks findings critical / high /
medium / cosmetic. Each finding comes with repro steps and a screenshot,
because a bug report you can't reproduce is worthless.

## Using qab by hand

The agent does everything through the `qab` CLI, and you can too. A
background daemon keeps the browser warm so commands come back in ~100ms:

```bash
qab session start myapp          # new report folder, recording starts
qab goto http://localhost:3000   # reports console errors + failed requests
qab snapshot                     # accessibility-tree view of the page
qab click "text=Sign up"
qab fill "#email" user@test.dev
qab shot signup                  # full-page screenshot -> frontend/
qab phase mobile                 # switch to 375x812, new recording
qab phase backend
qab api POST http://localhost:3000/api/users '{"email":""}'
qab engine firefox               # rerun anything in firefox
qab session end                  # finalizes the last recording
qab stop                         # kill the daemon
```

`qab help` lists everything. Daemon state and logs live in `~/.qa-bot/`.

## Testing behind a login

If the app needs an account, the agent will ask you for test credentials and
log in through the form like a user would. Use a staging account. Don't point
it at production with real customer data.

## Rolling it out to the team

There's nothing to deploy server-side. Each developer runs the setup above
once on their machine and updates with:

```bash
git pull && npm run build
```

If the daemon acts weird after an update, `qab stop` and try again.

## Troubleshooting

- **daemon failed to start** — check `~/.qa-bot/daemon.log`
- **want to watch it work** — everything is headless by default;
  `qab engine chromium headed` opens a visible window
- **`qab engine chrome` fails** — Chrome isn't installed on that machine.
  Chromium is the same engine and always available.
- **recordings look letterboxed** — don't resize with `qab viewport` during a
  session; use `qab phase mobile`, which starts a fresh recording at the right
  size
