import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.ts';

const ROBOT_DIR = path.join(DATA_DIR, 'robot');
const ROBOT_KEY_PATH = path.join(ROBOT_DIR, '.robot_api_key');

export function getRobotApiKey(): string {
  const fromEnv = (process.env.YANDEX_ROBOT_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  try {
    fs.mkdirSync(ROBOT_DIR, { recursive: true });
    if (fs.existsSync(ROBOT_KEY_PATH)) {
      const existing = fs.readFileSync(ROBOT_KEY_PATH, 'utf-8').trim();
      if (existing) return existing;
    }
    const generated = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(ROBOT_KEY_PATH, generated, { encoding: 'utf-8', mode: 0o600 });
    return generated;
  } catch {
    return '';
  }
}

export function getRobotBaseUrl(): string {
  const raw = (process.env.YANDEX_ROBOT_URL || '').trim();
  if (raw) return raw.replace(/\/+$/, '');
  // Inside Docker compose, service name `yandex-robot` resolves on port 8100 when profile `robot` is active.
  return 'http://yandex-robot:8100';
}

export class RobotUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RobotUnavailableError';
  }
}

export class RobotRejectedError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'RobotRejectedError';
    this.statusCode = statusCode;
  }
}

export interface RobotCallOptions {
  params?: Record<string, string | number | boolean | undefined>;
  json?: unknown;
  timeoutMs?: number;
  raw?: boolean;
}

export async function callRobot(
  method: string,
  endpointPath: string,
  opts: RobotCallOptions = {},
): Promise<{ status: number; headers: Headers; body: Buffer; jsonData?: unknown }> {
  const base = getRobotBaseUrl();
  const url = new URL(`${base}${endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`}`);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {};
  const apiKey = getRobotApiKey();
  if (apiKey) headers['X-Robot-Key'] = apiKey;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 25000);
  try {
    const resp = await fetch(url.toString(), {
      method,
      headers,
      body,
      signal: ctrl.signal,
    });
    const arr = await resp.arrayBuffer();
    const buf = Buffer.from(arr);

    if (resp.status >= 400 && !opts.raw) {
      let detail = `Робот вернул ошибку ${resp.status}`;
      try {
        const parsed = JSON.parse(buf.toString('utf-8')) as { detail?: string };
        if (parsed?.detail) detail = String(parsed.detail);
      } catch {
        // ignore
      }
      throw new RobotRejectedError(resp.status, detail);
    }

    if (opts.raw) {
      return { status: resp.status, headers: resp.headers, body: buf };
    }
    let jsonData: unknown = null;
    if (buf.length > 0) {
      try {
        jsonData = JSON.parse(buf.toString('utf-8'));
      } catch {
        jsonData = buf.toString('utf-8');
      }
    }
    return { status: resp.status, headers: resp.headers, body: buf, jsonData };
  } catch (err) {
    if (err instanceof RobotRejectedError || err instanceof RobotUnavailableError) throw err;
    const msg =
      err instanceof Error && err.name === 'AbortError'
        ? 'Робот браузера не ответил вовремя'
        : 'Робот браузера Яндекса не запущен или недоступен';
    throw new RobotUnavailableError(msg);
  } finally {
    clearTimeout(timer);
  }
}
