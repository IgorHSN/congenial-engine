import { createHash } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DownloadInfo, ModelFolder } from '@shared/types';
import { newId } from '../store';

export interface DownloadRequest {
  label: string;
  url: string;
  folder: ModelFolder;
  /** Path relative to the model folder. */
  file: string;
  /** Absolute destination path. */
  dest: string;
  headers?: Record<string, string>;
  expectedSha256?: string;
}

interface Active {
  info: DownloadInfo;
  req: DownloadRequest;
  controller: AbortController;
  promise: Promise<DownloadInfo>;
}

const MAX_CONCURRENT = 2;

/** Download queue with progress, cancellation and SHA-256 verification. */
export class Downloader {
  private items = new Map<string, Active>();
  private running = 0;
  private waiting: Array<() => void> = [];
  private listeners = new Set<(list: DownloadInfo[]) => void>();
  private lastEmit = 0;

  onChange(l: (list: DownloadInfo[]) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  list(): DownloadInfo[] {
    return [...this.items.values()].map((a) => ({ ...a.info })).reverse();
  }

  private emit(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    const list = this.list();
    for (const l of this.listeners) l(list);
  }

  /** Start a download; the returned promise resolves when it finishes (or fails/cancels). */
  enqueue(req: DownloadRequest): { id: string; done: Promise<DownloadInfo> } {
    const id = newId('dl-');
    const info: DownloadInfo = {
      id,
      label: req.label,
      folder: req.folder,
      file: req.file,
      url: redact(req.url),
      state: 'queued',
      receivedBytes: 0,
      totalBytes: null,
      bytesPerSecond: 0,
      startedAt: new Date().toISOString(),
    };
    const controller = new AbortController();
    const active: Active = { info, req, controller, promise: Promise.resolve(info) };
    active.promise = this.run(active);
    this.items.set(id, active);
    this.emit(true);
    return { id, done: active.promise };
  }

  cancel(id: string): boolean {
    const a = this.items.get(id);
    if (!a || ['done', 'error', 'cancelled'].includes(a.info.state)) return false;
    a.controller.abort();
    return true;
  }

  private async slot(): Promise<void> {
    if (this.running < MAX_CONCURRENT) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
  }

  private release(): void {
    this.running--;
    this.waiting.shift()?.();
  }

  private async run(a: Active): Promise<DownloadInfo> {
    const { info, req, controller } = a;
    await this.slot();
    const part = `${req.dest}.part`;
    try {
      if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError');
      info.state = 'downloading';
      this.emit(true);
      await fs.mkdir(dirname(req.dest), { recursive: true });

      const res = await fetch(req.url, { headers: req.headers, redirect: 'follow', signal: controller.signal });
      if (!res.ok || !res.body) {
        const hint =
          res.status === 401 || res.status === 403
            ? ' (o arquivo exige login: configure o token da Civitai/HuggingFace nas configurações)'
            : '';
        throw new Error(`HTTP ${res.status} ${res.statusText}${hint}`);
      }
      const len = Number(res.headers.get('content-length'));
      info.totalBytes = Number.isFinite(len) && len > 0 ? len : null;

      const hash = createHash('sha256');
      let windowStart = Date.now();
      let windowBytes = 0;
      const meter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          hash.update(chunk);
          info.receivedBytes += chunk.length;
          windowBytes += chunk.length;
          const elapsed = Date.now() - windowStart;
          if (elapsed >= 1000) {
            info.bytesPerSecond = Math.round((windowBytes * 1000) / elapsed);
            windowStart = Date.now();
            windowBytes = 0;
          }
          this.emit();
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
        meter,
        createWriteStream(part),
        { signal: controller.signal },
      );

      if (req.expectedSha256) {
        info.state = 'verifying';
        this.emit(true);
        const got = hash.digest('hex');
        if (got.toLowerCase() !== req.expectedSha256.toLowerCase()) {
          throw new Error(`SHA-256 não confere (esperado ${req.expectedSha256.slice(0, 12)}…, obtido ${got.slice(0, 12)}…)`);
        }
      }
      await fs.rename(part, req.dest);
      info.state = 'done';
    } catch (err) {
      await fs.rm(part, { force: true }).catch(() => undefined);
      if (controller.signal.aborted) {
        info.state = 'cancelled';
      } else {
        info.state = 'error';
        info.error = (err as Error).message;
      }
    } finally {
      info.finishedAt = new Date().toISOString();
      info.bytesPerSecond = 0;
      this.release();
      this.emit(true);
    }
    return { ...info };
  }
}

/** Hide tokens passed as query params when showing URLs. */
export function redact(url: string): string {
  try {
    const u = new URL(url);
    for (const k of ['token', 'access_token']) if (u.searchParams.has(k)) u.searchParams.set(k, '***');
    return u.toString();
  } catch {
    return url;
  }
}
