import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ComfyDetection } from '@shared/types';
import { ComfyClient } from './client';
import { rootFromModelsDir } from './modelDirs';
import { detectComfyLayout } from './paths';

function commonFolders(): string[] {
  const home = homedir();
  const names = ['ComfyUI_windows_portable', 'ComfyUI', 'comfyui', 'ComfyUI-portable'];
  const bases = [
    home,
    join(home, 'Desktop'),
    join(home, 'Downloads'),
    join(home, 'Documents'),
    join(home, 'AI'),
    join(home, 'ai'),
    join(home, 'stable-diffusion'),
  ];
  if (process.platform === 'win32') {
    for (const drive of ['C:', 'D:', 'E:', 'F:']) bases.push(`${drive}\\`, `${drive}\\AI`, `${drive}\\IA`, `${drive}\\Program Files`);
  }
  const out: string[] = [];
  for (const b of bases) for (const n of names) out.push(join(b, n));
  // Launchers that bundle ComfyUI.
  out.push(
    join(home, 'AppData', 'Roaming', 'StabilityMatrix', 'Packages', 'ComfyUI'),
    join(home, 'StabilityMatrix', 'Data', 'Packages', 'ComfyUI'),
    join(home, 'pinokio', 'api', 'comfy.git', 'app'),
  );
  return out;
}

function looksLikeComfy(path: string): string | null {
  const layout = detectComfyLayout(path);
  if (!layout) return null;
  if (layout.hasMainPy || (layout.hasModels && existsSync(join(layout.root, 'custom_nodes')))) return layout.root;
  return null;
}

/**
 * Find a ComfyUI install: first ask any server that is running (it reports its
 * model folders, so this also finds ComfyUI Desktop and custom locations),
 * then look in the usual install folders.
 */
export async function detectComfy(currentUrl: string): Promise<ComfyDetection> {
  const urls = [...new Set([currentUrl, 'http://127.0.0.1:8188', 'http://127.0.0.1:8000'].filter(Boolean))];
  let reachableUrl: string | undefined;
  for (const url of urls) {
    const client = new ComfyClient(() => url);
    try {
      await client.systemStats();
    } catch {
      continue;
    }
    reachableUrl ??= url;
    try {
      const paths = await client.folderPaths();
      for (const dir of paths.checkpoints ?? []) {
        const root = rootFromModelsDir(dir);
        const found = root ? looksLikeComfy(root) : null;
        if (found) return { url, rootPath: found, via: 'running-server', candidates: [found] };
      }
    } catch {
      /* older server without /internal/folder_paths */
    }
  }

  const candidates = [...new Set(commonFolders().map(looksLikeComfy).filter((p): p is string => !!p))];
  return { url: reachableUrl, rootPath: candidates[0], via: candidates.length ? 'folder' : undefined, candidates };
}
