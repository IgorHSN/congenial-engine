import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ApprovalRequest, McpActivity } from '@shared/types';
import { TOOL_PARAMS, ToolError, toolByName, type ToolContext, type ToolOutput } from '../claude/tools';
import { DENIED_PREFIX } from '../claude/transcript';
import { newId } from '../store';

export type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
}

export const MCP_DEFAULT_PORT = 47821;
export const MCP_ENDPOINT_FILE = 'mcp-endpoint.json';

export interface McpEndpoint {
  port: number;
  token: string;
  pid: number;
}

/** Tool definitions in MCP shape. */
export function mcpToolList() {
  return TOOL_PARAMS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
}

export function toMcpContent(out: ToolOutput): McpContent[] {
  if (typeof out === 'string') return [{ type: 'text', text: out }];
  const blocks = (Array.isArray(out) ? out : []) as Array<{ type: string; text?: string; source?: { type: string; data?: string; media_type?: string } }>;
  const content: McpContent[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') content.push({ type: 'text', text: b.text });
    else if (b.type === 'image' && b.source?.type === 'base64' && b.source.data) {
      content.push({ type: 'image', data: b.source.data, mimeType: b.source.media_type ?? 'image/png' });
    }
  }
  return content.length ? content : [{ type: 'text', text: '(no output)' }];
}

/** Validate and run one tool the same way the in-app agent does, returning an MCP result. */
export async function runToolForMcp(name: string, args: unknown, ctx: ToolContext): Promise<McpCallResult> {
  const def = toolByName(name);
  if (!def) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${name}.` }] };
  const parsed = def.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ INVALID_INPUT: parsed.error.issues.slice(0, 5) }) }] };
  }
  try {
    const out = (await (def.run as (i: unknown, c: ToolContext) => Promise<ToolOutput>)(parsed.data, ctx)) as ToolOutput;
    const denied = typeof out === 'string' && out.startsWith(DENIED_PREFIX);
    return denied ? { isError: true, content: toMcpContent(out) } : { content: toMcpContent(out) };
  } catch (err) {
    const text = ctx.signal.aborted ? 'Cancelled.' : err instanceof ToolError ? err.message : `Error: ${(err as Error).message}`;
    return { isError: true, content: [{ type: 'text', text }] };
  }
}

interface HostDeps {
  dataDir: string;
  toolContext: Omit<ToolContext, 'approve' | 'signal' | 'background'>;
  /** Ask the user in the app window. */
  approve: (req: Omit<ApprovalRequest, 'requestId' | 'toolUseId'>) => Promise<boolean>;
  onActivity: (a: McpActivity) => void;
  preferredPort?: number;
}

/**
 * Local HTTP endpoint the MCP bridge talks to. Bound to 127.0.0.1, protected
 * by a random token stored in the app's data folder, and closed to browsers
 * (requests carrying an Origin header are rejected).
 */
export class McpHost {
  private server: Server | null = null;
  private readonly token = randomBytes(24).toString('hex');
  port: number | null = null;

  constructor(private readonly d: HostDeps) {}

  get running(): boolean {
    return this.server !== null;
  }

  async start(): Promise<number> {
    if (this.server && this.port) return this.port;
    const server = createServer((req, res) => void this.handle(req, res));
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve((server.address() as AddressInfo).port);
        });
      });
    let port: number;
    try {
      port = await listen(this.d.preferredPort ?? MCP_DEFAULT_PORT);
    } catch {
      port = await listen(0);
    }
    this.server = server;
    this.port = port;
    const endpoint: McpEndpoint = { port, token: this.token, pid: process.pid };
    await fs.mkdir(this.d.dataDir, { recursive: true });
    await fs.writeFile(join(this.d.dataDir, MCP_ENDPOINT_FILE), JSON.stringify(endpoint), { encoding: 'utf8', mode: 0o600 });
    return port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    await fs.rm(join(this.d.dataDir, MCP_ENDPOINT_FILE), { force: true }).catch(() => undefined);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.origin) return send(res, 403, { error: 'Browsers are not allowed.' });
    if (req.headers.authorization !== `Bearer ${this.token}`) return send(res, 401, { error: 'Bad token.' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/tools') return send(res, 200, { tools: mcpToolList() });
    if (req.method !== 'POST' || url.pathname !== '/call') return send(res, 404, { error: 'Not found.' });

    let body: { name?: unknown; arguments?: unknown };
    try {
      body = JSON.parse(await readBody(req, 2 * 1024 * 1024));
    } catch {
      return send(res, 400, { error: 'Invalid JSON.' });
    }
    const name = String(body.name ?? '');
    const controller = new AbortController();
    // The bridge closes the connection when the client cancels the call.
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });

    const id = newId('mcp-');
    this.d.onActivity({ id, tool: name, phase: 'start', at: new Date().toISOString() });
    const result = await runToolForMcp(name, body.arguments, {
      ...this.d.toolContext,
      signal: controller.signal,
      background: true,
      approve: (r) => this.d.approve(r),
    });
    const first = result.content.find((c) => c.type === 'text');
    this.d.onActivity({
      id,
      tool: name,
      phase: 'end',
      ok: !result.isError,
      summary: first && first.type === 'text' ? first.text.slice(0, 200) : undefined,
      at: new Date().toISOString(),
    });
    if (!res.destroyed) send(res, 200, result);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Body too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
