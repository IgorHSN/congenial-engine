import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import { MODEL_FOLDERS, type InstalledModel, type ModelFolder, type ModelMeta } from '@shared/types';
import { JsonFile } from '../store';
import { ModelDirectories } from './modelDirs';
import { detectMeta } from './modelMeta';
import { modelsDir, safeJoin } from './paths';

const MODEL_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pt2', '.pth', '.bin', '.gguf', '.sft', '.onnx', '.pkl']);

type Registry = Record<string, ModelMeta>;
type AutoCache = Record<string, { size: number; mtimeMs: number; meta: ModelMeta }>;

function key(folder: ModelFolder, file: string): string {
  return `${folder}/${file.replace(/\\/g, '/')}`;
}

/**
 * Lists model files ComfyUI can see (models/, extra_model_paths.yaml and the
 * paths the running server reports) and merges two kinds of metadata:
 * auto-detected (safetensors header, sidecar files, file name) and explicit
 * (set by Claude or the user), explicit winning.
 */
export class ModelInventory {
  private registry: Registry = {};
  private auto: AutoCache = {};
  private readonly file: JsonFile<Registry>;
  private readonly autoFile: JsonFile<AutoCache>;
  private loaded = false;
  readonly directories: ModelDirectories;

  constructor(
    dataDir: string,
    private readonly getRoot: () => string,
    fetchServerPaths: () => Promise<Record<string, string[]>> = async () => ({}),
  ) {
    this.file = new JsonFile(join(dataDir, 'models.json'), () => ({}));
    this.autoFile = new JsonFile(join(dataDir, 'models-auto.json'), () => ({}));
    this.directories = new ModelDirectories(getRoot, fetchServerPaths);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.registry = await this.file.read();
    this.auto = await this.autoFile.read();
    this.loaded = true;
  }

  root(): string {
    const root = this.getRoot();
    if (!root) throw new Error('A pasta do ComfyUI ainda não foi configurada (Configurações → ComfyUI).');
    return root;
  }

  /** Where new downloads for this folder go. */
  primaryDir(folder: ModelFolder): string {
    return modelsDir(this.root(), folder);
  }

  async dirs(folder: ModelFolder): Promise<string[]> {
    return (await this.directories.all())[folder];
  }

  async list(folder?: ModelFolder): Promise<InstalledModel[]> {
    await this.ensureLoaded();
    this.root();
    const all = await this.directories.all();
    const folders = folder ? [folder] : [...MODEL_FOLDERS];
    const out: InstalledModel[] = [];
    const seenPaths = new Set<string>();
    let autoChanged = false;

    for (const f of folders) {
      const seenFiles = new Set<string>();
      for (const base of all[f]) {
        for (const abs of await walk(base)) {
          const lower = abs.toLowerCase();
          if (!MODEL_EXTENSIONS.has(lower.slice(lower.lastIndexOf('.')))) continue;
          const pathKey = process.platform === 'win32' ? lower : abs;
          const file = relative(base, abs).split('\\').join('/');
          // ComfyUI resolves a name to the first directory that has it.
          if (seenPaths.has(pathKey) || seenFiles.has(file)) continue;
          seenPaths.add(pathKey);
          seenFiles.add(file);

          let stat: import('node:fs').Stats;
          try {
            stat = await fs.stat(abs);
          } catch {
            continue;
          }
          let cached = this.auto[abs];
          if (!cached || cached.size !== stat.size || cached.mtimeMs !== stat.mtimeMs) {
            cached = { size: stat.size, mtimeMs: stat.mtimeMs, meta: await detectMeta(abs, f, file) };
            this.auto[abs] = cached;
            autoChanged = true;
          }
          out.push({ folder: f, file, path: abs, sizeBytes: stat.size, meta: this.merge(cached.meta, this.registry[key(f, file)]) });
        }
      }
    }
    if (autoChanged) await this.autoFile.write(this.auto);
    return out.sort((a, b) => (a.folder + a.file).localeCompare(b.folder + b.file));
  }

  private merge(auto: ModelMeta, explicit: ModelMeta | undefined): ModelMeta {
    if (!explicit) return { ...auto };
    const merged: ModelMeta = { ...auto, ...strip(explicit) };
    if (explicit.baseModel) delete merged.detectedFrom;
    return merged;
  }

  async getMeta(folder: ModelFolder, file: string): Promise<ModelMeta> {
    await this.ensureLoaded();
    const path = await this.locate(folder, file);
    const auto = path ? this.auto[path]?.meta : undefined;
    return this.merge(auto ?? {}, this.registry[key(folder, file)]);
  }

  /** Explicit metadata only (what the user/Claude set). */
  async getExplicitMeta(folder: ModelFolder, file: string): Promise<ModelMeta | undefined> {
    await this.ensureLoaded();
    return this.registry[key(folder, file)];
  }

  async setMeta(folder: ModelFolder, file: string, patch: ModelMeta): Promise<ModelMeta> {
    await this.ensureLoaded();
    const k = key(folder, file);
    const next = { ...(this.registry[k] ?? {}), ...strip(patch) };
    delete next.detectedFrom;
    this.registry[k] = next;
    await this.file.write(this.registry);
    return this.getMeta(folder, file);
  }

  /** Absolute path of a model, searching every directory ComfyUI uses for that folder. */
  async locate(folder: ModelFolder, file: string): Promise<string | null> {
    for (const base of await this.dirs(folder)) {
      let candidate: string;
      try {
        candidate = safeJoin(base, file);
      } catch {
        return null;
      }
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        /* next dir */
      }
    }
    return null;
  }

  async exists(folder: ModelFolder, file: string): Promise<boolean> {
    return (await this.locate(folder, file)) !== null;
  }

  async remove(folder: ModelFolder, file: string): Promise<void> {
    await this.ensureLoaded();
    const abs = await this.locate(folder, file);
    if (!abs) throw new Error(`models/${folder}/${file} não encontrado.`);
    await fs.unlink(abs);
    delete this.registry[key(folder, file)];
    delete this.auto[abs];
    await this.file.write(this.registry);
    await this.autoFile.write(this.auto);
  }

  async sha256(folder: ModelFolder, file: string): Promise<string> {
    const abs = await this.locate(folder, file);
    if (!abs) throw new Error(`models/${folder}/${file} não encontrado.`);
    return hashFile(abs);
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
  if (depth > 6) return [];
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
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = (await fs.stat(abs)).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDir) out.push(...(await walk(abs, depth + 1)));
    else out.push(abs);
  }
  return out;
}

function strip<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
