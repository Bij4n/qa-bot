#!/usr/bin/env node
// QA-Bot browser daemon. Holds a live Playwright browser so each CLI call
// is a fast localhost HTTP request instead of a cold browser launch.
//
// Sessions are organized by test phase (frontend / mobile / backend). Each
// phase runs in its own browser context so Playwright's video recording —
// which only finalizes when a context closes — yields one recording per
// phase: recordings/<phase>-<engine>.webm.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { LOG_FILE, STATE_DIR, clearStateIfOwned, writeState } from './state.js';

const ENGINES = ['chromium', 'chrome', 'firefox'] as const;
type Engine = (typeof ENGINES)[number];

const PHASES = ['frontend', 'mobile', 'backend'] as const;
type Phase = (typeof PHASES)[number];

const PHASE_VIEWPORTS: Record<Phase, { width: number; height: number }> = {
  frontend: { width: 1280, height: 800 },
  mobile: { width: 375, height: 812 },
  backend: { width: 1280, height: 800 },
};

const BUFFER_CAP = 500;
const SNAPSHOT_CAP = 20_000;
const BODY_PREVIEW_CAP = 2_000;

interface ConsoleEntry {
  type: string;
  text: string;
  location?: string;
  ts: string;
}

interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  ms?: number;
  failure?: string;
  ts: string;
}

interface Session {
  dir: string;
  phase: Phase;
  shotCounters: Partial<Record<Phase, number>>;
}

let engine: Engine = 'chromium';
let headed = false;
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let session: Session | null = null;
let adhocShotCounter = 0;

const consoleBuf: ConsoleEntry[] = [];
const networkBuf: NetworkEntry[] = [];

fs.mkdirSync(STATE_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
function log(msg: string): void {
  logStream.write(`${new Date().toISOString()} ${msg}\n`);
}

function push<T>(buf: T[], entry: T): void {
  buf.push(entry);
  if (buf.length > BUFFER_CAP) buf.shift();
}

function attachPage(p: Page): void {
  p.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning') return;
    const loc = msg.location();
    push(consoleBuf, {
      type,
      text: msg.text(),
      location: loc.url ? `${loc.url}:${loc.lineNumber}` : undefined,
      ts: new Date().toISOString(),
    });
  });
  p.on('pageerror', (err) => {
    push(consoleBuf, { type: 'pageerror', text: String(err), ts: new Date().toISOString() });
  });
  p.on('requestfailed', (req) => {
    push(networkBuf, {
      method: req.method(),
      url: req.url(),
      failure: req.failure()?.errorText ?? 'failed',
      ts: new Date().toISOString(),
    });
  });
  p.on('response', (res) => {
    const timing = res.request().timing();
    push(networkBuf, {
      method: res.request().method(),
      url: res.url(),
      status: res.status(),
      ms: timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : undefined,
      ts: new Date().toISOString(),
    });
  });
}

function currentViewport(): { width: number; height: number } {
  return session ? PHASE_VIEWPORTS[session.phase] : PHASE_VIEWPORTS.frontend;
}

/** Open a fresh context. Inside a session, it records video at the phase viewport. */
async function openContext(): Promise<void> {
  if (!browser) throw new Error('browser not launched');
  const viewport = currentViewport();
  context = await browser.newContext({
    viewport,
    ...(session
      ? { recordVideo: { dir: path.join(session.dir, 'recordings'), size: viewport } }
      : {}),
  });
  page = await context.newPage();
  attachPage(page);
}

/** Close the current context; inside a session this finalizes the phase recording. */
async function closeContext(): Promise<void> {
  if (!context) return;
  const video = page?.video() ?? null;
  const phase = session?.phase;
  const closingEngine = engine;
  await context.close().catch(() => {});
  context = null;
  page = null;
  if (video && session && phase) {
    const dir = path.join(session.dir, 'recordings');
    let target = path.join(dir, `${phase}-${closingEngine}.webm`);
    for (let n = 2; fs.existsSync(target); n++) {
      target = path.join(dir, `${phase}-${closingEngine}-${n}.webm`);
    }
    try {
      await video.saveAs(target);
      await video.delete();
      log(`recording saved: ${target}`);
    } catch (err) {
      log(`recording save failed: ${err}`);
    }
  }
}

async function launch(nextEngine: Engine, nextHeaded: boolean): Promise<void> {
  await closeContext();
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  const options = { headless: !nextHeaded };
  if (nextEngine === 'firefox') {
    browser = await firefox.launch(options);
  } else if (nextEngine === 'chrome') {
    browser = await chromium.launch({ ...options, channel: 'chrome' });
  } else {
    browser = await chromium.launch(options);
  }
  engine = nextEngine;
  headed = nextHeaded;
  await openContext();
  log(`launched ${nextEngine} (headed=${nextHeaded})`);
}

async function ensurePage(): Promise<Page> {
  if (!browser) {
    await launch(engine, headed);
  } else if (!context) {
    await openContext();
  }
  return page as Page;
}

function isFailure(entry: NetworkEntry): boolean {
  return entry.failure !== undefined || (entry.status !== undefined && entry.status >= 400);
}

/** Snapshot buffer positions before an action, report only what the action caused. */
function markBuffers(): { c: number; n: number } {
  return { c: consoleBuf.length, n: networkBuf.length };
}

function bufferDeltas(mark: { c: number; n: number }) {
  const newConsole = consoleBuf.slice(mark.c);
  const newFailures = networkBuf.slice(mark.n).filter(isFailure);
  return {
    consoleErrors: newConsole.filter((e) => e.type !== 'warning'),
    consoleWarnings: newConsole.filter((e) => e.type === 'warning').length,
    failedRequests: newFailures,
  };
}

async function settle(p: Page): Promise<void> {
  await p.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
  await p.waitForTimeout(300);
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'session';
}

function nextShotFile(name: string, cwd: string): string {
  if (session) {
    const phase = session.phase;
    const count = (session.shotCounters[phase] ?? 0) + 1;
    session.shotCounters[phase] = count;
    const dir = path.join(session.dir, phase);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${String(count).padStart(2, '0')}-${name}.png`);
  }
  adhocShotCounter += 1;
  const dir = path.join(cwd, 'reports', '_adhoc');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${String(adhocShotCounter).padStart(2, '0')}-${name}.png`);
}

function truncate(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}\n… [truncated ${text.length - cap} chars]` : text;
}

type Handler = (args: string[], cwd: string) => Promise<unknown>;

const handlers: Record<string, Handler> = {
  async status() {
    return {
      running: true,
      engine,
      headed,
      url: page ? page.url() : null,
      title: page ? await page.title().catch(() => null) : null,
      session: session?.dir ?? null,
      phase: session?.phase ?? null,
      consoleBuffered: consoleBuf.length,
      networkBuffered: networkBuf.length,
    };
  },

  async engine(args) {
    const next = args[0] as Engine;
    if (!ENGINES.includes(next)) throw new Error(`unknown engine "${args[0]}" — use: ${ENGINES.join(', ')}`);
    await launch(next, args.includes('headed'));
    return { engine, headed, phase: session?.phase ?? null };
  },

  async phase(args) {
    if (!session) throw new Error('no active session — run: qab session start <name>');
    const next = args[0] as Phase;
    if (!PHASES.includes(next)) throw new Error(`unknown phase "${args[0]}" — use: ${PHASES.join(', ')}`);
    await ensurePage();
    await closeContext();
    session.phase = next;
    await openContext();
    const viewport = currentViewport();
    return {
      phase: next,
      viewport: `${viewport.width}x${viewport.height}`,
      recording: `recordings/${next}-${engine}.webm (finalized when the phase ends)`,
    };
  },

  async goto(args) {
    const url = args[0];
    if (!url) throw new Error('usage: goto <url>');
    const p = await ensurePage();
    const mark = markBuffers();
    await p.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await settle(p);
    return { url: p.url(), title: await p.title(), ...bufferDeltas(mark) };
  },

  async click(args) {
    const selector = args.join(' ');
    if (!selector) throw new Error('usage: click <selector>');
    const p = await ensurePage();
    const mark = markBuffers();
    await p.locator(selector).first().click({ timeout: 10_000 });
    await settle(p);
    return { url: p.url(), title: await p.title(), ...bufferDeltas(mark) };
  },

  async fill(args) {
    const [selector, ...rest] = args;
    if (!selector || rest.length === 0) throw new Error('usage: fill <selector> <value>');
    const p = await ensurePage();
    await p.locator(selector).first().fill(rest.join(' '), { timeout: 10_000 });
    return { filled: selector };
  },

  async press(args) {
    const key = args[0];
    if (!key) throw new Error('usage: press <key>  (e.g. Enter, Tab, Escape)');
    const p = await ensurePage();
    const mark = markBuffers();
    await p.keyboard.press(key);
    await settle(p);
    return { url: p.url(), ...bufferDeltas(mark) };
  },

  async hover(args) {
    const selector = args.join(' ');
    if (!selector) throw new Error('usage: hover <selector>');
    const p = await ensurePage();
    await p.locator(selector).first().hover({ timeout: 10_000 });
    return { hovered: selector };
  },

  async scroll(args) {
    const p = await ensurePage();
    if (args[0] === 'bottom') {
      await p.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    } else if (args[0] === 'top') {
      await p.evaluate('window.scrollTo(0, 0)');
    } else {
      const dy = Number(args[0] ?? 600);
      await p.evaluate(`window.scrollBy(0, ${dy})`);
    }
    await p.waitForTimeout(200);
    return { scrolled: args[0] ?? '600' };
  },

  async viewport(args) {
    const width = Number(args[0]);
    const height = Number(args[1]);
    if (!width || !height) throw new Error('usage: viewport <width> <height>  (note: inside a session, prefer `qab phase mobile` — recordings keep the viewport they started with)');
    const p = await ensurePage();
    await p.setViewportSize({ width, height });
    return { viewport: `${width}x${height}` };
  },

  async snapshot() {
    const p = await ensurePage();
    const yaml = await p.locator('body').ariaSnapshot();
    return { url: p.url(), title: await p.title(), snapshot: truncate(yaml, SNAPSHOT_CAP) };
  },

  async shot(args, cwd) {
    const p = await ensurePage();
    const name = slugify(args.join(' ') || 'shot');
    const file = nextShotFile(name, cwd);
    await p.screenshot({ path: file, fullPage: !args.includes('viewport') });
    return { path: file };
  },

  async console(args) {
    if (args[0] === 'clear') {
      consoleBuf.length = 0;
      return { cleared: true };
    }
    return { entries: consoleBuf.slice(-100) };
  },

  async network(args) {
    if (args[0] === 'clear') {
      networkBuf.length = 0;
      return { cleared: true };
    }
    const entries = args[0] === 'failed' ? networkBuf.filter(isFailure) : networkBuf;
    return { entries: entries.slice(-100) };
  },

  async eval(args) {
    const code = args.join(' ');
    if (!code) throw new Error('usage: eval <js-expression>');
    const p = await ensurePage();
    const result = await p.evaluate(code);
    return { result: truncate(JSON.stringify(result) ?? 'undefined', BODY_PREVIEW_CAP) };
  },

  async api(args) {
    const [method, url, ...rest] = args;
    if (!method || !url) throw new Error('usage: api <METHOD> <url> [json-body]');
    const headers: Record<string, string> = {};
    const body = rest.join(' ') || undefined;
    if (body) headers['content-type'] = 'application/json';
    const t0 = Date.now();
    let result: Record<string, unknown>;
    try {
      const res = await fetch(url, { method: method.toUpperCase(), headers, body });
      const ms = Date.now() - t0;
      const text = await res.text();
      let validJson: boolean | undefined;
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('json')) {
        try {
          JSON.parse(text);
          validJson = true;
        } catch {
          validJson = false;
        }
      }
      result = { status: res.status, httpOk: res.ok, ms, contentType, validJson, bodyPreview: truncate(text, BODY_PREVIEW_CAP) };
    } catch (err) {
      result = { error: String(err), ms: Date.now() - t0 };
    }
    if (session) {
      const backendDir = path.join(session.dir, 'backend');
      fs.mkdirSync(backendDir, { recursive: true });
      const entry: Record<string, unknown> = { ts: new Date().toISOString(), method: method.toUpperCase(), url, body, ...result };
      if (typeof entry.bodyPreview === 'string') entry.bodyPreview = truncate(entry.bodyPreview, 500);
      fs.appendFileSync(path.join(backendDir, 'api-log.jsonl'), `${JSON.stringify(entry)}\n`);
    }
    return result;
  },

  async session(args, cwd) {
    const sub = args[0];
    if (sub === 'start') {
      await closeContext();
      const name = slugify(args.slice(1).join(' ') || 'qa');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const dir = path.join(cwd, 'reports', `${stamp}-${name}`);
      for (const sub of [...PHASES, 'recordings']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
      session = { dir, phase: 'frontend', shotCounters: {} };
      consoleBuf.length = 0;
      networkBuf.length = 0;
      if (browser) await openContext();
      return {
        session: dir,
        phase: 'frontend',
        structure: 'frontend/ mobile/ backend/ recordings/ — screenshots route to the current phase, api calls log to backend/api-log.jsonl',
      };
    }
    if (sub === 'end') {
      if (!session) return { ended: null };
      await closeContext();
      const ended = session.dir;
      session = null;
      return { ended, recordings: listRecordings(ended) };
    }
    return { session: session?.dir ?? null, phase: session?.phase ?? null, shots: session?.shotCounters ?? {} };
  },

  async stop() {
    // Deregister immediately so the next qab command starts a fresh daemon
    // instead of reaching this one while its browser is still closing.
    clearStateIfOwned(process.pid);
    setTimeout(async () => {
      await closeContext();
      if (browser) await browser.close().catch(() => {});
      server.close();
      logStream.end();
      process.exit(0);
    }, 100);
    return { stopping: true };
  },
};

function listRecordings(sessionDir: string): string[] {
  try {
    return fs.readdirSync(path.join(sessionDir, 'recordings')).filter((f) => f.endsWith('.webm'));
  } catch {
    return [];
  }
}

const token = crypto.randomBytes(24).toString('hex');

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/cmd' || req.headers['x-qab-token'] !== token) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', async () => {
    res.setHeader('content-type', 'application/json');
    try {
      const { cmd, args = [], cwd = process.cwd() } = JSON.parse(raw);
      const handler = handlers[cmd];
      if (!handler) throw new Error(`unknown command "${cmd}"`);
      const result = await handler(args, cwd);
      res.end(JSON.stringify({ ok: true, ...((result ?? {}) as object) }));
    } catch (err) {
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const initialEngine = process.argv[2] as Engine | undefined;
  if (initialEngine && ENGINES.includes(initialEngine)) engine = initialEngine;
  writeState({ port, token, pid: process.pid, engine });
  log(`daemon listening on 127.0.0.1:${port} (pid ${process.pid})`);
});

process.on('SIGTERM', () => {
  clearStateIfOwned(process.pid);
  process.exit(0);
});
