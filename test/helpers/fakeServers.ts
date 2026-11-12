import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

// 1x1 transparent PNG
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

export interface FakeComfy {
  url: string;
  prompts: Array<Record<string, { class_type: string; inputs: Record<string, unknown> }>>;
  close: () => Promise<void>;
}

/** A tiny stand-in for the ComfyUI server: /prompt, /history, /view, /ws, /system_stats. */
export async function startFakeComfy(opts: { failValidation?: boolean; folderPaths?: Record<string, string[]> } = {}): Promise<FakeComfy> {
  const prompts: FakeComfy['prompts'] = [];
  const history = new Map<string, unknown>();
  const sockets = new Map<string, WebSocket>();
  let counter = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/system_stats') {
      return sendJson(res, 200, {
        system: { comfyui_version: '0.9.0', python_version: '3.12.7 (main)', os: 'posix' },
        devices: [{ name: 'cuda:0 Fake GPU', type: 'cuda', vram_total: 12 * 1024 ** 3, vram_free: 10 * 1024 ** 3 }],
      });
    }
    if (url.pathname === '/queue') return sendJson(res, 200, { queue_running: [], queue_pending: [] });
    if (url.pathname === '/internal/folder_paths') {
      return opts.folderPaths ? sendJson(res, 200, opts.folderPaths) : sendJson(res, 404, {});
    }
    if (url.pathname === '/object_info/KSampler') {
      return sendJson(res, 200, {
        KSampler: {
          name: 'KSampler',
          category: 'sampling',
          input: { required: { sampler_name: [['euler', 'dpmpp_2m']], steps: ['INT', { default: 20, min: 1, max: 10000 }] } },
          output: ['LATENT'],
        },
      });
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { prompt: FakeComfy['prompts'][number]; client_id: string };
      if (opts.failValidation) {
        return sendJson(res, 400, {
          error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '' },
          node_errors: {
            '1': {
              class_type: 'CheckpointLoaderSimple',
              errors: [{ message: 'Value not in list', details: "ckpt_name: 'missing.safetensors' not in []" }],
            },
          },
        });
      }
      prompts.push(body.prompt);
      const promptId = `p${++counter}`;
      sendJson(res, 200, { prompt_id: promptId, number: counter, node_errors: {} });

      const saveNode = Object.entries(body.prompt).find(([, n]) => n.class_type === 'SaveImage');
      const latent = Object.values(body.prompt).find((n) => n.class_type.startsWith('Empty'));
      const batch = Number(latent?.inputs.batch_size ?? 1);
      const ws = sockets.get(body.client_id);
      setTimeout(() => {
        ws?.send(JSON.stringify({ type: 'execution_start', data: { prompt_id: promptId } }));
        for (let i = 1; i <= 4; i++) ws?.send(JSON.stringify({ type: 'progress', data: { value: i, max: 4, prompt_id: promptId } }));
        history.set(promptId, {
          outputs: saveNode
            ? {
                [saveNode[0]]: {
                  images: Array.from({ length: batch }, (_, i) => ({
                    filename: `atelier_${promptId}_${i}.png`,
                    subfolder: '',
                    type: 'output',
                  })),
                },
              }
            : {},
          status: { status_str: 'success', completed: true, messages: [] },
        });
        ws?.send(JSON.stringify({ type: 'executing', data: { node: null, prompt_id: promptId } }));
      }, 30);
      return;
    }
    const hist = url.pathname.match(/^\/history\/(.+)$/);
    if (hist) {
      const h = history.get(hist[1]);
      return sendJson(res, 200, h ? { [hist[1]]: h } : {});
    }
    if (url.pathname === '/view') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(TINY_PNG);
    }
    sendJson(res, 404, { error: 'not found' });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.set(url.searchParams.get('clientId') ?? '', ws);
      ws.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } } } }));
    });
  });

  const url = await listen(server);
  return {
    url,
    prompts,
    close: async () => {
      for (const ws of sockets.values()) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface FakeOllama {
  url: string;
  requests: Array<{ model: string; messages: Array<{ role: string; content: string }>; format?: unknown; keep_alive?: unknown }>;
  close: () => Promise<void>;
}

/** Fake Ollama /api/chat that answers with whatever `reply` returns. */
export async function startFakeOllama(reply: (messages: Array<{ role: string; content: string }>) => string): Promise<FakeOllama> {
  const requests: FakeOllama['requests'] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/tags') return sendJson(res, 200, { models: [{ name: 'fake-llm:8b' }] });
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      requests.push(body);
      return sendJson(res, 200, { message: { role: 'assistant', content: reply(body.messages) }, done: true });
    }
    sendJson(res, 404, {});
  });
  const url = await listen(server);
  return { url, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Static file server for download tests. */
export async function startFileServer(files: Record<string, Buffer>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const data = files[new URL(req.url ?? '/', 'http://x').pathname];
    if (!data) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-length': data.length, 'content-type': 'application/octet-stream' });
    res.end(data);
  });
  const url = await listen(server);
  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
