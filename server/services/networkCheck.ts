import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PingResult {
  ok: boolean;
  latency_ms: number | null;
  detail: string;
  binary_missing?: boolean;
}

export interface PortResult {
  ok: boolean;
  latency_ms: number | null;
  detail: string;
}

let pingBinaryAvailable: boolean | null = null;

export async function pingHost(ip: string, attempts = 2, timeoutSec = 2): Promise<PingResult> {
  const cleanIp = (ip || '').trim();
  if (!cleanIp) {
    return { ok: false, latency_ms: null, detail: 'IP-адрес не указан' };
  }
  if (pingBinaryAvailable === false) {
    return { ok: false, latency_ms: null, detail: 'На сервере не установлена утилита ping', binary_missing: true };
  }

  for (let i = 0; i < attempts; i++) {
    try {
      const started = Date.now();
      const { stdout } = await execFileAsync('ping', ['-c', '1', '-W', String(timeoutSec), cleanIp], {
        timeout: (timeoutSec + 1) * 1000,
      });
      pingBinaryAvailable = true;
      const m = stdout.match(/time[=<]([\d.]+)\s*ms/i) || stdout.match(/=\s*[\d.]+\/([\d.]+)\//);
      const latency = m ? Math.round(Number(m[1]) * 10) / 10 : Date.now() - started;
      return { ok: true, latency_ms: latency, detail: 'Доступен' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        pingBinaryAvailable = false;
        return { ok: false, latency_ms: null, detail: 'На сервере не установлена утилита ping', binary_missing: true };
      }
      pingBinaryAvailable = true;
      if (i + 1 < attempts) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
  return { ok: false, latency_ms: null, detail: `Нет ответа (${attempts} попытки)` };
}

export function checkTcpPort(ip: string, portInput: string | number, timeoutMs = 2500, attempts = 2): Promise<PortResult> {
  const cleanIp = (ip || '').trim();
  const port = Number(portInput);
  if (!cleanIp) {
    return Promise.resolve({ ok: false, latency_ms: null, detail: 'IP-адрес не указан' });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve({ ok: false, latency_ms: null, detail: 'Некорректный порт' });
  }

  const attemptOnce = (): Promise<PortResult> =>
    new Promise((resolve) => {
      const started = Date.now();
      const sock = new net.Socket();
      let settled = false;
      const finish = (ok: boolean, detail: string) => {
        if (settled) return;
        settled = true;
        try {
          sock.destroy();
        } catch {
          // ignore
        }
        resolve({ ok, latency_ms: ok ? Date.now() - started : null, detail });
      };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => finish(true, 'Веб-интерфейс отвечает'));
      sock.once('timeout', () => finish(false, 'Таймаут TCP'));
      sock.once('error', (err) => finish(false, err.message || 'Порт недоступен'));
      sock.connect(port, cleanIp);
    });

  return (async () => {
    for (let i = 0; i < attempts; i++) {
      const res = await attemptOnce();
      if (res.ok) return res;
      if (i + 1 < attempts) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return { ok: false, latency_ms: null, detail: `Порт недоступен (${attempts} попытки)` };
  })();
}
