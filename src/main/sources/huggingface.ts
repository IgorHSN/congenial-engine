const HF = 'https://huggingface.co';

export interface HfFile {
  path: string;
  size: number;
  sha256?: string;
}

export class HuggingFaceClient {
  constructor(private readonly getToken: () => string | undefined) {}

  headers(): Record<string, string> {
    const token = this.getToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  async search(query: string, limit = 10): Promise<Array<{ repo: string; downloads?: number; likes?: number; tags?: string[] }>> {
    const url = new URL(`${HF}/api/models`);
    url.searchParams.set('search', query);
    url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 30)));
    url.searchParams.set('sort', 'downloads');
    url.searchParams.set('direction', '-1');
    const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`HuggingFace respondeu HTTP ${res.status}`);
    const items = (await res.json()) as Array<{ id: string; downloads?: number; likes?: number; tags?: string[] }>;
    return items.map((i) => ({ repo: i.id, downloads: i.downloads, likes: i.likes, tags: i.tags?.slice(0, 8) }));
  }

  async listFiles(repo: string, revision = 'main'): Promise<HfFile[]> {
    const url = `${HF}/api/models/${repo}/tree/${encodeURIComponent(revision)}?recursive=true`;
    const res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(30000) });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Repositório ${repo} é restrito (gated). Aceite os termos no site e configure o token do HuggingFace.`);
    }
    if (!res.ok) throw new Error(`HuggingFace respondeu HTTP ${res.status} para ${repo}`);
    const items = (await res.json()) as Array<{ type: string; path: string; size: number; lfs?: { oid?: string } }>;
    return items
      .filter((i) => i.type === 'file')
      .map((i) => ({ path: i.path, size: i.size, sha256: i.lfs?.oid }));
  }

  downloadUrl(repo: string, path: string, revision = 'main'): string {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    return `${HF}/${repo}/resolve/${encodeURIComponent(revision)}/${encodedPath}?download=true`;
  }
}

/** Parse https://huggingface.co/owner/repo/(blob|resolve)/rev/path/to/file */
export function parseHfUrl(input: string): { repo: string; revision: string; path?: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.hostname !== 'huggingface.co' && url.hostname !== 'hf.co') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repo = `${parts[0]}/${parts[1]}`;
  if ((parts[2] === 'blob' || parts[2] === 'resolve') && parts.length >= 5) {
    return { repo, revision: decodeURIComponent(parts[3]), path: parts.slice(4).map(decodeURIComponent).join('/') };
  }
  return { repo, revision: 'main' };
}
