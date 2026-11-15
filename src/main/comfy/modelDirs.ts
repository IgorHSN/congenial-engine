import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { MODEL_FOLDERS, type ModelFolder } from '@shared/types';

/** ComfyUI maps these legacy names to the new ones (folder_paths.map_legacy). */
export function mapLegacy(name: string): string {
  return ({ unet: 'diffusion_models', clip: 'text_encoders' } as Record<string, string>)[name] ?? name;
}

/** os.path.expandvars + expanduser, for $VAR, ${VAR}, %VAR% and a leading ~. */
export function expandPath(p: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = p.replace(/^~(?=$|[\\/])/, homedir());
  out = out.replace(/\$\{(\w+)\}|\$(\w+)|%(\w+)%/g, (m, a, b, c) => env[a ?? b ?? c] ?? m);
  return out;
}

/**
 * Parse extra_model_paths.yaml the way ComfyUI does (utils/extra_config.py):
 * base_path is expanded and resolved relative to the YAML file, each value may
 * hold several newline-separated paths, and relative paths without base_path
 * are resolved relative to the YAML file. Keys go through map_legacy.
 */
export function parseExtraModelPaths(yamlText: string, yamlDir: string, env?: NodeJS.ProcessEnv): Record<string, string[]> {
  const config = parseYaml(yamlText) as Record<string, Record<string, unknown> | null> | null;
  const out: Record<string, string[]> = {};
  if (!config || typeof config !== 'object') return out;
  for (const section of Object.values(config)) {
    if (!section || typeof section !== 'object') continue;
    const conf = { ...section };
    let basePath: string | null = null;
    if (typeof conf.base_path === 'string') {
      basePath = expandPath(conf.base_path, env);
      if (!isAbsolute(basePath)) basePath = resolve(yamlDir, basePath);
    }
    delete conf.base_path;
    const isDefault = conf.is_default === true;
    delete conf.is_default;
    for (const [key, value] of Object.entries(conf)) {
      if (typeof value !== 'string') continue;
      const folder = mapLegacy(key);
      for (const line of value.split('\n')) {
        if (!line.trim()) continue;
        const entry = line.trim();
        const full = basePath ? (isAbsolute(entry) ? entry : join(basePath, entry)) : isAbsolute(entry) ? entry : resolve(yamlDir, entry);
        const list = (out[folder] ??= []);
        if (isDefault) list.unshift(normalize(full));
        else list.push(normalize(full));
      }
    }
  }
  return out;
}

export function readExtraModelPaths(comfyRoot: string): Record<string, string[]> {
  const file = join(comfyRoot, 'extra_model_paths.yaml');
  if (!existsSync(file)) return {};
  try {
    return parseExtraModelPaths(readFileSync(file, 'utf8'), dirname(file));
  } catch {
    return {};
  }
}

/**
 * Every directory ComfyUI searches, per app folder. Order: the default
 * models/<folder>, then extra_model_paths.yaml, then what the running server
 * reports (/internal/folder_paths, which also covers --models-directory and
 * ComfyUI Desktop's own config).
 */
export class ModelDirectories {
  private serverCache: { at: number; root: string; value: Record<string, string[]> | null } = { at: 0, root: '', value: null };

  constructor(
    private readonly getRoot: () => string,
    private readonly fetchServerPaths: () => Promise<Record<string, string[]>>,
  ) {}

  private async serverPaths(): Promise<Record<string, string[]>> {
    const root = this.getRoot();
    if (this.serverCache.root !== root) this.serverCache = { at: 0, root, value: null };
    const cache = this.serverCache;
    if (Date.now() - cache.at < 30_000) return cache.value ?? {};
    try {
      cache.value = await this.fetchServerPaths();
    } catch {
      // Keep the last answer for this install: its folders are still on disk
      // while ComfyUI is stopped, and downloads should keep going to the same place.
    }
    cache.at = Date.now();
    return cache.value ?? {};
  }

  invalidate(): void {
    this.serverCache.at = 0;
  }

  /**
   * Where new files for a folder go: the first path the running server reports,
   * which is ComfyUI's own default (ComfyUI Desktop's shared models folder, or an
   * extra_model_paths.yaml entry marked is_default) and where ComfyUI-Manager
   * installs too. Falls back to <root>/models/<folder>. Legacy names (clip, unet)
   * keep their own default dir, the only one all() scans for them.
   */
  async defaultDir(folder: ModelFolder): Promise<string> {
    const fallback = normalize(join(this.getRoot(), 'models', folder));
    if (folder === 'clip' || folder === 'unet') return fallback;
    const dirs = ((await this.serverPaths())[folder] ?? []).filter((d) => isAbsolute(d));
    const first = dirs[0];
    if (!first) return fallback;
    // One base can hold several names for a folder (clip and text_encoders,
    // t2i_adapter and controlnet): prefer the folder's own name there.
    const own = dirs.find((d) => basename(d).toLowerCase() === folder && relative(dirname(d), dirname(first)) === '');
    return normalize(own ?? first);
  }

  async all(): Promise<Record<ModelFolder, string[]>> {
    const root = this.getRoot();
    const extra = root ? readExtraModelPaths(root) : {};
    const server = await this.serverPaths();
    const out = {} as Record<ModelFolder, string[]>;
    for (const folder of MODEL_FOLDERS) {
      const dirs: string[] = [];
      if (root) dirs.push(join(root, 'models', folder));
      // Legacy app folders (clip, unet) only use their own default dir; the
      // extra/server paths are listed under the new names to avoid duplicates.
      if (folder !== 'clip' && folder !== 'unet') {
        dirs.push(...(extra[folder] ?? []), ...(server[folder] ?? []));
      }
      const seen = new Set<string>();
      out[folder] = dirs.map((d) => normalize(d)).filter((d) => {
        const k = process.platform === 'win32' ? d.toLowerCase() : d;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return out;
  }
}

/** Given a models/<folder> path reported by the server, guess the ComfyUI base folder. */
export function rootFromModelsDir(checkpointsDir: string): string | null {
  const parts = normalize(checkpointsDir).split(/[\\/]/);
  const i = parts.lastIndexOf('models');
  if (i <= 0) return null;
  return parts.slice(0, i).join('/') || null;
}
