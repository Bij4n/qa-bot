#!/usr/bin/env node
// qab — QA-Bot browser CLI. Talks to the daemon (auto-starting it if needed)
// so every command returns in ~100ms against a warm browser.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOG_FILE, clearState, readState } from './state.js';
import type { DaemonState } from './state.js';

const HELP = `qab — QA-Bot browser CLI (chromium | chrome | firefox, all platforms)

Session
  qab session start <name>     begin a QA session (reports/<ts>-<name>/, clears buffers)
  qab session end              close the current session
  qab status                   daemon + page state

Navigation & interaction
  qab goto <url>               navigate (reports new console errors + failed requests)
  qab click <selector>         click (css, text=..., role=... selectors)
  qab fill <selector> <value>  fill an input
  qab press <key>              press a key (Enter, Tab, Escape)
  qab hover <selector>         hover an element
  qab scroll [bottom|top|px]   scroll the page
  qab viewport <w> <h>         resize (e.g. 375 812 for mobile)

Observation
  qab snapshot                 accessibility-tree snapshot of the page
  qab shot [name]              full-page screenshot into the session dir
  qab console [clear]          buffered console errors/warnings
  qab network [failed|clear]   captured requests (status, timing, failures)
  qab eval <js>                evaluate JS in the page

Backend
  qab api <METHOD> <url> [json-body]   direct HTTP check (status, latency, body)

Engine & lifecycle
  qab engine <name> [headed]   switch browser: chromium, chrome, firefox
  qab stop                     shut down the daemon
`;

async function ping(state: DaemonState): Promise<boolean> {
  try {
    const res = await send(state, 'status', [], 1_500);
    return res.ok === true;
  } catch {
    return false;
  }
}

async function send(
  state: DaemonState,
  cmd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${state.port}/cmd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-qab-token': state.token },
    body: JSON.stringify({ cmd, args, cwd: process.cwd() }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function startDaemon(): Promise<DaemonState> {
  const daemonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daemon.js');
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const state = readState();
    if (state && (await ping(state))) return state;
  }
  throw new Error(`daemon failed to start — check ${LOG_FILE}`);
}

async function ensureDaemon(): Promise<DaemonState> {
  const state = readState();
  if (state && (await ping(state))) return state;
  clearState();
  return startDaemon();
}

function print(cmd: string, res: Record<string, unknown>): void {
  if (res.ok === false) {
    console.error(`error: ${res.error}`);
    process.exitCode = 1;
    return;
  }
  delete res.ok;
  if (cmd === 'snapshot' && typeof res.snapshot === 'string') {
    console.log(`# ${res.title}\n# ${res.url}\n`);
    console.log(res.snapshot);
    return;
  }
  console.log(JSON.stringify(res, null, 2));
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }
  if (cmd === 'stop') {
    const state = readState();
    if (!state || !(await ping(state))) {
      clearState();
      console.log('daemon not running');
      return;
    }
    await send(state, 'stop', []);
    clearState();
    console.log('daemon stopped');
    return;
  }
  const state = await ensureDaemon();
  const res = await send(state, cmd, args);
  print(cmd, res);
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
