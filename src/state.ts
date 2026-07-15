import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DaemonState {
  port: number;
  token: string;
  pid: number;
  engine: string;
}

export const STATE_DIR = path.join(os.homedir(), '.qa-bot');
export const STATE_FILE = path.join(STATE_DIR, 'daemon.json');
export const LOG_FILE = path.join(STATE_DIR, 'daemon.log');

export function readState(): DaemonState | null {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw) as DaemonState;
    if (!state.port || !state.token || !state.pid) return null;
    return state;
  } catch {
    return null;
  }
}

export function writeState(state: DaemonState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function clearState(): void {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch {
    // already gone
  }
}
