import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { MODEL_FOLDERS, type InstalledModel, type ModelFolder, type ModelMeta } from '@shared/types';
import { JsonFile } from '../store';
import { modelsDir, safeJoin } from './paths';

const MODEL_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.sft', '.onnx']);

type Registry = Record<string, ModelMeta>;

function key(folder: ModelFolder, file: string): string {
  return `${folder}/${file.replace(/\\/g, '/')}`;
}

/** Lists model files on disk and keeps app-side metadata (trigger words, base model, source...). */
export class ModelInventory {
  private registry: Registry = {};
  private readonly file: JsonFile<Registry>;
  private loaded = false;

  constructor(
    dataDir: string,
    private readonly getRoot: () => string,
  ) {
    this.file = new JsonFile(join(dataDir, 'models.json'), () => ({}));
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.registry = await this.file.read();
    this.loaded = true;
  }

  root(): string {
    const root = this.getRoot();
    if (!root) throw new Error('A pasta do ComfyUI ainda não foi configurada (Configurações → ComfyUI).');
    return root;
  }

  async list(folder?: ModelFolder): Promise<InstalledModel[]> {
    await this.ensureLoaded();
    const root = this.root();
    const folders = folder ? [folder] : [...MODEL_FOLDERS];
    const out: InstalledModel[] = [];
    for (const f of folders) {
      const base = modelsDir(root, f);
      for (const abs of await walk(base)) {
        const lower = abs.toLowerCase();
        const ext = lower.slice(lower.lastIndexOf('.'));
        if (!MODEL_EXTENSIONS.has(ext)) continue;
        const stat = await fs.stat(abs);
        const file = relative(base, abs).split('\\').join('/');
        out.push({ folder: f, file, sizeBytes: stat.size, meta: this.registry[key(f, file)] ?? {} });
      }
    }
    return out.sort((a, b) => (a.folder + a.file).localeCompare(b.folder + b.file));
  }

  async getMeta(folder: ModelFolder, file: string): Promise<ModelMeta> {
    await this.ensureLoaded();
    return this.registry[key(folder, file)] ?? {};
  }

  async setMeta(folder: ModelFolder, file: string, patch: ModelMeta): Promise<ModelMeta> {
    await this.ensureLoaded();
    const k = key(folder, file);
    const next = { ...(this.registry[k] ?? {}), ...stripUndefined(patch) };
    this.registry[k] = next;
    await this.file.write(this.registry);
    return next;
  }

  async exists(folder: ModelFolder, file: string): Promise<boolean> {
    try {
      await fs.access(safeJoin(modelsDir(this.root(), folder), file));
      return true;
    } catch {
      return false;
    }
  }

  async remove(folder: ModelFolder, file: string): Promise<void> {
    await this.ensureLoaded();
    const abs = safeJoin(modelsDir(this.root(), folder), file);
    await fs.unlink(abs);
    delete this.registry[key(folder, file)];
    await this.file.write(this.registry);
  }

  absolutePath(folder: ModelFolder, file: string): string {
    return safeJoin(modelsDir(this.root(), folder), file);
  }

  async sha256(folder: ModelFolder, file: string): Promise<string> {
    return hashFile(this.absolutePath(folder, file));
  }
}

export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => hash.update(d))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function walk(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(abs, depth + 1)));
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
