import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Small JSON persistence helper: atomic writes (tmp file + rename) and a
 * write queue so concurrent saves never interleave.
 */
export class JsonFile<T> {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly fallback: () => T,
  ) {}

  async read(): Promise<T> {
    try {
      const raw = await fs.readFile(this.path, 'utf8');
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return this.fallback();
      // A corrupt file should not brick the app: keep a copy and start fresh.
      try {
        await fs.copyFile(this.path, `${this.path}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      return this.fallback();
    }
  }

  write(value: T): Promise<void> {
    const next = this.queue.then(async () => {
      await fs.mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
      await fs.rename(tmp, this.path);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export function newId(prefix = ''): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}
