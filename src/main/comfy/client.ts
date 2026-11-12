import WebSocket from 'ws';
import { newId } from '../store';

export type ComfyGraph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;

export interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

export interface RunOptions {
  onProgress?: (p: { value: number; max: number; node?: string }) => void;
  onQueued?: (promptId: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class ComfyError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface SystemStats {
  system?: { comfyui_version?: string; python_version?: string; os?: string };
  devices?: Array<{ name: string; type: string; vram_total: number; vram_free: number }>;
}

/** Minimal client for the ComfyUI HTTP + WebSocket API. */
export class ComfyClient {
  constructor(private readonly getBaseUrl: () => string) {}

  get baseUrl(): string {
    return this.getBaseUrl().replace(/\/+$/, '');
  }

  private async request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 15000);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: init?.signal ?? controller.signal });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* not json */
      }
      if (!res.ok) {
        throw new ComfyError(formatComfyError(res.status, body), body);
      }
      return body as T;
    } catch (err) {
      if (err instanceof ComfyError) throw err;
      throw new ComfyError(`Não foi possível conectar ao ComfyUI em ${this.baseUrl}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  systemStats(): Promise<SystemStats> {
    return this.request<SystemStats>('/system_stats', { timeoutMs: 4000 });
  }

  async queue(): Promise<{ running: number; pending: number }> {
    const q = await this.request<{ queue_running: unknown[]; queue_pending: unknown[] }>('/queue', { timeoutMs: 4000 });
    return { running: q.queue_running?.length ?? 0, pending: q.queue_pending?.length ?? 0 };
  }

  /**
   * Every model directory the server searches, per folder name (includes
   * extra_model_paths.yaml and --models-directory). Internal frontend route.
   */
  async folderPaths(): Promise<Record<string, string[]>> {
    const res = await this.request<Record<string, unknown>>('/internal/folder_paths', { timeoutMs: 4000 });
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(res ?? {})) {
      // Current servers return a list of dirs; tolerate the [dirs, extensions] tuple too.
      const dirs = Array.isArray(v) && Array.isArray(v[0]) ? v[0] : v;
      if (Array.isArray(dirs)) out[k] = dirs.filter((d): d is string => typeof d === 'string');
    }
    return out;
  }

  objectInfo(nodeClass?: string): Promise<Record<string, NodeInfo>> {
    const path = nodeClass ? `/object_info/${encodeURIComponent(nodeClass)}` : '/object_info';
    return this.request(path, { timeoutMs: 30000 });
  }

  async interrupt(): Promise<void> {
    await this.request('/interrupt', { method: 'POST' });
  }

  async freeMemory(): Promise<void> {
    await this.request('/free', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
  }

  /** Asks ComfyUI-Manager (if installed) to restart the server. */
  async managerReboot(): Promise<boolean> {
    for (const path of ['/api/manager/reboot', '/manager/reboot']) {
      try {
        await this.request(path, { method: 'GET', timeoutMs: 5000 });
        return true;
      } catch (err) {
        // A reboot usually kills the connection mid-request: treat that as success.
        if (err instanceof ComfyError && !err.details) return true;
      }
    }
    return false;
  }

  async queuePrompt(graph: ComfyGraph, clientId: string): Promise<string> {
    const res = await this.request<{ prompt_id: string; node_errors?: Record<string, unknown> }>('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
      timeoutMs: 30000,
    });
    if (res.node_errors && Object.keys(res.node_errors).length > 0) {
      throw new ComfyError(formatComfyError(400, res), res);
    }
    return res.prompt_id;
  }

  async history(promptId: string): Promise<HistoryEntry | null> {
    const res = await this.request<Record<string, HistoryEntry>>(`/history/${encodeURIComponent(promptId)}`);
    return res?.[promptId] ?? null;
  }

  async fetchImage(ref: ComfyImageRef): Promise<Buffer> {
    const qs = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder ?? '', type: ref.type ?? 'output' });
    const res = await fetch(`${this.baseUrl}/view?${qs}`);
    if (!res.ok) throw new ComfyError(`Falha ao baixar imagem ${ref.filename}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Queues a workflow and waits until it finishes. Uses the WebSocket for
   * progress and completion, with /history polling as a fallback.
   */
  async run(graph: ComfyGraph, opts: RunOptions = {}): Promise<{ promptId: string; images: ComfyImageRef[] }> {
    const clientId = newId('atelier-');
    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`;
    let ws: WebSocket | null = null;
    let promptId: string | null = null;
    let settled = false;

    const done = new Promise<void>((resolve, reject) => {
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(poller);
        clearTimeout(timeout);
        opts.signal?.removeEventListener('abort', onAbort);
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve();
      };

      const onAbort = () => {
        void this.interrupt().catch(() => undefined);
        finish(new ComfyError('Geração cancelada.'));
      };
      opts.signal?.addEventListener('abort', onAbort);

      const timeout = setTimeout(
        () => finish(new ComfyError('Tempo esgotado esperando o ComfyUI terminar.')),
        opts.timeoutMs ?? 30 * 60 * 1000,
      );

      const poller = setInterval(async () => {
        if (!promptId || settled) return;
        try {
          const h = await this.history(promptId);
          if (h?.status?.completed || h?.status?.status_str === 'success') finish();
          else if (h?.status?.status_str === 'error') finish(new ComfyError(historyError(h)));
        } catch {
          /* keep polling */
        }
      }, 2500);

      try {
        ws = new WebSocket(wsUrl);
        ws.on('message', (data, isBinary) => {
          if (isBinary) return; // live previews
          let msg: { type: string; data: Record<string, unknown> };
          try {
            msg = JSON.parse(data.toString());
          } catch {
            return;
          }
          const pid = msg.data?.prompt_id as string | undefined;
          if (promptId && pid && pid !== promptId) return;
          switch (msg.type) {
            case 'progress':
              opts.onProgress?.({
                value: Number(msg.data.value),
                max: Number(msg.data.max),
                node: msg.data.node as string | undefined,
              });
              break;
            case 'executing':
              if (msg.data.node === null && pid === promptId) finish();
              break;
            case 'execution_success':
              if (pid === promptId) finish();
              break;
            case 'execution_error':
              finish(
                new ComfyError(
                  `Erro no nó ${String(msg.data.node_type ?? msg.data.node_id)}: ${String(msg.data.exception_message ?? 'erro desconhecido').trim()}`,
                  msg.data,
                ),
              );
              break;
            case 'execution_interrupted':
              finish(new ComfyError('Execução interrompida no ComfyUI.'));
              break;
          }
        });
        ws.on('error', () => {
          /* polling covers us */
        });
      } catch {
        /* polling covers us */
      }
    });
    // Avoid an unhandled rejection if queuePrompt throws before we await `done`.
    done.catch(() => undefined);

    // Give the socket a moment to connect so early events are not missed.
    await new Promise<void>((resolve) => {
      if (!ws) return resolve();
      const t = setTimeout(resolve, 1500);
      ws.once('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.once('error', () => {
        clearTimeout(t);
        resolve();
      });
    });

    try {
      promptId = await this.queuePrompt(graph, clientId);
    } catch (err) {
      settled = true;
      try {
        (ws as WebSocket | null)?.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
    opts.onQueued?.(promptId);
    await done;

    const entry = await this.history(promptId);
    const images: ComfyImageRef[] = [];
    for (const output of Object.values(entry?.outputs ?? {})) {
      for (const img of output.images ?? []) {
        if (img.type === 'output') images.push(img);
      }
    }
    return { promptId, images };
  }
}

export interface NodeInfo {
  name: string;
  display_name?: string;
  category?: string;
  description?: string;
  input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> };
  output?: string[];
}

interface HistoryEntry {
  outputs?: Record<string, { images?: ComfyImageRef[] }>;
  status?: { status_str?: string; completed?: boolean; messages?: Array<[string, Record<string, unknown>]> };
}

function historyError(h: HistoryEntry): string {
  const err = h.status?.messages?.find((m) => m[0] === 'execution_error')?.[1];
  if (err) return `Erro no nó ${String(err.node_type)}: ${String(err.exception_message ?? '').trim()}`;
  return 'O ComfyUI reportou erro na execução.';
}

export function formatComfyError(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as {
      error?: { message?: string; details?: string } | string;
      node_errors?: Record<string, { class_type?: string; errors?: Array<{ message?: string; details?: string }> }>;
    };
    const parts: string[] = [];
    if (typeof b.error === 'string') parts.push(b.error);
    else if (b.error?.message) parts.push(b.error.message + (b.error.details ? `: ${b.error.details}` : ''));
    for (const [nodeId, ne] of Object.entries(b.node_errors ?? {})) {
      for (const e of ne.errors ?? []) {
        parts.push(`nó ${nodeId} (${ne.class_type ?? '?'}): ${e.message ?? ''}${e.details ? ` - ${e.details}` : ''}`);
      }
    }
    if (parts.length) return parts.join('\n');
  }
  return `HTTP ${status}: ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body)?.slice(0, 500)}`;
}
