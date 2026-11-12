import type { BaseModel, ModelFolder } from '@shared/types';

const API = 'https://civitai.com/api/v1';

export interface CivitaiFile {
  id?: number;
  name: string;
  sizeKB: number;
  type: string;
  primary?: boolean;
  metadata?: { fp?: string; size?: string; format?: string };
  hashes?: Record<string, string>;
  downloadUrl: string;
}

export interface CivitaiVersion {
  id: number;
  modelId?: number;
  name: string;
  baseModel: string;
  trainedWords?: string[];
  description?: string | null;
  files: CivitaiFile[];
  images?: Array<{ url: string; nsfwLevel?: number }>;
  model?: { name: string; type: string; nsfw: boolean };
}

export interface CivitaiModel {
  id: number;
  name: string;
  type: string;
  nsfw: boolean;
  description?: string | null;
  tags?: string[];
  creator?: { username?: string };
  stats?: { downloadCount?: number; thumbsUpCount?: number; rating?: number };
  modelVersions: CivitaiVersion[];
}

export const CIVITAI_TYPES = ['Checkpoint', 'LORA', 'LoCon', 'DoRA', 'TextualInversion', 'VAE', 'Controlnet', 'Upscaler'] as const;
export type CivitaiType = (typeof CIVITAI_TYPES)[number];

export class CivitaiClient {
  constructor(private readonly getToken: () => string | undefined) {}

  private async get<T>(path: string, params?: Record<string, string | number | boolean | string[] | undefined>): Promise<T> {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, String(v));
    }
    const token = this.getToken();
    const res = await fetch(url, {
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Civitai respondeu HTTP ${res.status} em ${path}`);
    return (await res.json()) as T;
  }

  search(opts: {
    query?: string;
    types?: string[];
    baseModels?: string[];
    nsfw?: boolean;
    sort?: string;
    limit?: number;
    tag?: string;
  }): Promise<{ items: CivitaiModel[] }> {
    return this.get('/models', {
      query: opts.query || undefined,
      tag: opts.tag || undefined,
      types: opts.types,
      baseModels: opts.baseModels,
      nsfw: opts.nsfw,
      sort: opts.sort ?? 'Most Downloaded',
      limit: Math.min(Math.max(opts.limit ?? 8, 1), 20),
    });
  }

  model(id: number): Promise<CivitaiModel> {
    return this.get(`/models/${id}`);
  }

  version(id: number): Promise<CivitaiVersion> {
    return this.get(`/model-versions/${id}`);
  }

  versionByHash(hash: string): Promise<CivitaiVersion> {
    return this.get(`/model-versions/by-hash/${encodeURIComponent(hash)}`);
  }

  /** Download URL with the token as a query param (survives the redirect to the CDN). */
  downloadUrl(file: CivitaiFile): string {
    const token = this.getToken();
    const url = new URL(file.downloadUrl);
    if (token) url.searchParams.set('token', token);
    return url.toString();
  }
}

export function parseCivitaiRef(input: string): { modelId?: number; versionId?: number } | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return { modelId: Number(trimmed) };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!/(^|\.)civitai\.(com|green|red)$/.test(url.hostname)) return null;
  const out: { modelId?: number; versionId?: number } = {};
  const m = url.pathname.match(/^\/models\/(\d+)/);
  if (m) out.modelId = Number(m[1]);
  const v = url.searchParams.get('modelVersionId') ?? url.pathname.match(/\/api\/download\/models\/(\d+)/)?.[1];
  if (v) out.versionId = Number(v);
  return out.modelId || out.versionId ? out : null;
}

export function civitaiBaseModel(base: string | undefined): BaseModel | undefined {
  if (!base) return undefined;
  const b = base.toLowerCase();
  if (b.includes('pony')) return 'pony';
  if (b.includes('illustrious')) return 'illustrious';
  if (b.includes('noob')) return 'noobai';
  if (b.includes('flux')) return 'flux';
  if (b.startsWith('sd 3.5') || b.startsWith('sd3.5')) return 'sd35';
  if (b.startsWith('sd 1') || b === 'sd1.5') return 'sd15';
  if (b.includes('sdxl') || b.includes('xl')) return 'sdxl';
  return 'other';
}

export function civitaiFolder(type: string | undefined): ModelFolder {
  switch ((type ?? '').toLowerCase()) {
    case 'checkpoint':
      return 'checkpoints';
    case 'textualinversion':
      return 'embeddings';
    case 'vae':
      return 'vae';
    case 'controlnet':
      return 'controlnet';
    case 'upscaler':
      return 'upscale_models';
    default:
      return 'loras';
  }
}

/** Pick the file to download from a version: primary safetensors first. */
export function pickCivitaiFile(files: CivitaiFile[], fileName?: string): CivitaiFile | undefined {
  if (fileName) {
    const exact = files.find((f) => f.name === fileName);
    if (exact) return exact;
  }
  const models = files.filter((f) => f.type === 'Model' || f.type === 'Pruned Model');
  const pool = models.length ? models : files;
  return (
    pool.find((f) => f.primary && f.metadata?.format === 'SafeTensor') ??
    pool.find((f) => f.metadata?.format === 'SafeTensor') ??
    pool.find((f) => f.primary) ??
    pool[0]
  );
}

/** Compact representation for the Claude tool results (keeps token usage low). */
export function summarizeCivitaiModel(m: CivitaiModel, maxVersions = 3) {
  return {
    modelId: m.id,
    name: m.name,
    type: m.type,
    nsfw: m.nsfw,
    creator: m.creator?.username,
    downloads: m.stats?.downloadCount,
    likes: m.stats?.thumbsUpCount,
    tags: m.tags?.slice(0, 8),
    url: `https://civitai.com/models/${m.id}`,
    versions: m.modelVersions.slice(0, maxVersions).map(summarizeCivitaiVersion),
  };
}

export function summarizeCivitaiVersion(v: CivitaiVersion) {
  return {
    versionId: v.id,
    name: v.name,
    baseModel: v.baseModel,
    trainedWords: v.trainedWords?.slice(0, 12),
    files: v.files.slice(0, 4).map((f) => ({
      name: f.name,
      sizeMB: Math.round(f.sizeKB / 1024),
      type: f.type,
      format: f.metadata?.format,
      fp: f.metadata?.fp,
      primary: !!f.primary,
    })),
  };
}

export function stripHtml(html: string | null | undefined, max = 1200): string {
  if (!html) return '';
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
