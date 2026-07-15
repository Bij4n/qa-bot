# qa-bot development

Agent-driven QA for web apps: the `qab` CLI (Playwright daemon) + a Claude Code
skill (`skill/SKILL.md`) that drives it. See README.md for usage.

## Commands

```bash
npm install                 # deps
npx playwright install chromium firefox
npm run build               # tsc -> dist/
npm run dev <cmd>           # run the CLI from source, e.g. npm run dev status
node dist/cli.js <cmd>      # or `qab <cmd>` after npm link
```

No automated test suite yet. Smoke-test changes manually:

```bash
qab session start smoke && qab goto https://example.com && qab shot home \
  && qab phase mobile && qab goto https://example.com && qab shot home \
  && qab phase backend && qab api GET https://example.com \
  && qab session end && qab stop
```

Then check the session folder: screenshots in `frontend/` and `mobile/`,
`backend/api-log.jsonl` populated, and `recordings/*.webm` playable
(`ffprobe` should show real durations and per-phase dimensions).

## Architecture invariants

- **Playwright video only finalizes when its browser context closes.** That's
  why sessions are phase-scoped: `qab phase X` closes the old context (saving
  its recording) and opens a new one at the phase viewport. Don't try to grab
  a recording mid-phase, and don't resize with `viewport` during a session.
- **The daemon state file (`~/.qa-bot/daemon.json`) is only cleared by its
  owner.** A dying daemon must deregister *before* closing its browser
  (`clearStateIfOwned` in `src/state.ts`) or it races a replacement daemon.
  Don't reorder the stop handler in `src/daemon.ts`.
- **The CLI protocol reserves `ok`.** Handler results are spread into
  `{ok: true, ...result}`, so no handler may return its own `ok` field —
  that's why `api` returns `httpOk`.
- Each CLI call sends its `cwd`; session report folders are created relative
  to where the user ran `qab`, not where the daemon started.

## Git

- Two remotes, keep them in sync: `origin` (Biodexic/qa-bot, private) and
  `personal` (Bij4n/qa-bot, public). Push both: `git push origin && git push personal`.
- Commit style: short, plain, lowercase messages ("fix cd path in clone
  instructions"), no conventional-commit prefixes, no Co-Authored-By trailers,
  no tool attribution.
