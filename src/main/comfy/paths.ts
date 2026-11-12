import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ModelFolder } from '@shared/types';

export interface ComfyLayout {
  root: string;
  python: string | null;
  kind: 'portable' | 'venv' | 'system' | 'unknown';
  hasMainPy: boolean;
  hasModels: boolean;
}

/** Inspect a folder and figure out how this ComfyUI install is laid out. */
export function detectComfyLayout(input: string): ComfyLayout | null {
  if (!input) return null;
  let root = resolve(input);
  // Accept the portable package's outer folder too.
  if (!existsSync(join(root, 'main.py')) && existsSync(join(root, 'ComfyUI', 'main.py'))) {
    root = join(root, 'ComfyUI');
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) return null;

  const hasMainPy = existsSync(join(root, 'main.py'));
  const hasModels = existsSync(join(root, 'models'));
  const win = process.platform === 'win32';
  const candidates: Array<{ path: string; kind: ComfyLayout['kind'] }> = [
    { path: join(dirname(root), 'python_embeded', 'python.exe'), kind: 'portable' },
    { path: join(root, '.venv', win ? 'Scripts/python.exe' : 'bin/python'), kind: 'venv' },
    { path: join(root, 'venv', win ? 'Scripts/python.exe' : 'bin/python'), kind: 'venv' },
  ];
  const found = candidates.find((c) => existsSync(c.path));
  return {
    root,
    python: found?.path ?? null,
    kind: found?.kind ?? (hasMainPy ? 'system' : 'unknown'),
    hasMainPy,
    hasModels,
  };
}

export function modelsDir(root: string, folder: ModelFolder): string {
  return join(root, 'models', folder);
}

/**
 * Resolve a model-relative path and make sure it cannot escape the folder
 * (the path comes from the model, so treat it as untrusted).
 */
export function safeJoin(base: string, rel: string): string {
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const target = resolve(base, cleaned);
  const r = relative(base, target);
  if (!r || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) {
    throw new Error(`Caminho inválido: ${rel}`);
  }
  return target;
}

/** Strip characters that are invalid in file names on Windows/macOS/Linux. */
export function sanitizeFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? name;
  return base.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim() || 'model.safetensors';
}
