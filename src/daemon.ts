#!/usr/bin/env node
// QA-Bot browser daemon. Holds a live Playwright browser so each CLI call
// is a fast localhost HTTP request instead of a cold browser launch.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { LOG_FILE, STATE_DIR, clearState, writeState } from './state.js';

const ENGINES = ['chromium', 'chrome', 'firefox'] as const;
type Engine = (typeof ENGINES)[number];

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

let engine: Engine = 'chromium';
let headed = false;
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

const consoleBuf: ConsoleEntry[] = [];
const networkBuf: NetworkEntry[] = [];

let sessionDir: string | null = null;
let shotCounter = 0;

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

async function launch(nextEngine: Engine, nextHeaded: boolean): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    context = null;
    page = null;
  }
  const options = { headless: !nextHeaded };
  if (nextEngine === 'firefox') {
    browser = await firefox.launch(options);
  } else if (nextEngine === 'chrome') {
    browser = await chromium.launch({ ...options, channel: 'chrome' });
  } else {
    browser = await chromium.launch(options);
  }
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  attachPage(page);
  engine = nextEngine;
  headed = nextHeaded;
  log(`launched ${nextEngine} (headed=${nextHeaded})`);
}

async function ensurePage(): Promise<Page> {
  if (!page) await launch(engine, headed);
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

function shotDir(cwd: string): string {
  if (sessionDir) return sessionDir;
  const dir = path.join(cwd, 'reports', '_adhoc');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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
      session: sessionDir,
      consoleBuffered: consoleBuf.length,
      networkBuffered: networkBuf.length,
    };
  },

  async engine(args) {
    const next = args[0] as Engine;
    if (!ENGINES.includes(next)) throw new Error(`unknown engine "${args[0]}" — use: ${ENGINES.join(', ')}`);
    await launch(next, args.includes('headed'));
    return { engine, headed };
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
    if (!width || !height) throw new Error('usage: viewport <width> <height>');
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
    shotCounter += 1;
    const name = slugify(args.join(' ') || `shot-${shotCounter}`);
    const file = path.join(shotDir(cwd), `${String(shotCounter).padStart(2, '0')}-${name}.png`);
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
      return { status: res.status, ok: res.ok, ms, contentType, validJson, bodyPreview: truncate(text, BODY_PREVIEW_CAP) };
    } catch (err) {
      return { error: String(err), ms: Date.now() - t0 };
    }
  },

  async session(args, cwd) {
    const sub = args[0];
    if (sub === 'start') {
      const name = slugify(args.slice(1).join(' ') || 'qa');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      sessionDir = path.join(cwd, 'reports', `${stamp}-${name}`);
      fs.mkdirSync(sessionDir, { recursive: true });
      shotCounter = 0;
      consoleBuf.length = 0;
      networkBuf.length = 0;
      return { session: sessionDir };
    }
    if (sub === 'end') {
      const ended = sessionDir;
      sessionDir = null;
      return { ended };
    }
    return { session: sessionDir, shots: shotCounter };
  },

  async stop() {
    setTimeout(async () => {
      if (browser) await browser.close().catch(() => {});
      clearState();
      server.close();
      logStream.end();
      process.exit(0);
    }, 100);
    return { stopping: true };
  },
};

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
  clearState();
  process.exit(0);
});
