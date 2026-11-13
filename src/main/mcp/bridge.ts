import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_INSTRUCTIONS } from '../claude/prompt';
import { MCP_ENDPOINT_FILE, mcpToolList, type McpCallResult, type McpEndpoint } from './host';

/**
 * Minimal MCP server over stdio (JSON-RPC 2.0, one message per line) that
 * Claude Desktop / Claude Code launch. Tool calls are forwarded to the running
 * Comfy Atelier app, which owns settings, secrets, approvals and downloads.
 */

export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export interface BridgeOptions {
  dataDir: string;
  version: string;
  write: (msg: unknown) => void;
  /** Interval for progress notifications during long calls. */
  heartbeatMs?: number;
}

const APP_CLOSED =
  'Comfy Atelier is not open, so its tools are unavailable. Ask the user to open the Comfy Atelier app (it hosts these tools) and try again.';

export function readEndpoint(dataDir: string): McpEndpoint | null {
  try {
    const ep = JSON.parse(readFileSync(join(dataDir, MCP_ENDPOINT_FILE), 'utf8')) as McpEndpoint;
    return ep.port && ep.token ? ep : null;
  } catch {
    return null;
  }
}

export function createBridge(o: BridgeOptions) {
  const inflight = new Map<string | number, AbortController>();
  const reply = (id: JsonRpcMessage['id'], result: unknown) => o.write({ jsonrpc: '2.0', id, result });
  const fail = (id: JsonRpcMessage['id'], code: number, message: string) => o.write({ jsonrpc: '2.0', id, error: { code, message } });

  async function callApp(name: string, args: unknown, signal: AbortSignal): Promise<McpCallResult> {
    const ep = readEndpoint(o.dataDir);
    if (!ep) return { isError: true, content: [{ type: 'text', text: APP_CLOSED }] };
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${ep.port}/call`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ep.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name, arguments: args ?? {} }),
        signal,
      });
    } catch {
      if (signal.aborted) return { isError: true, content: [{ type: 'text', text: 'Cancelled.' }] };
      return { isError: true, content: [{ type: 'text', text: APP_CLOSED }] };
    }
    if (res.status === 401) return { isError: true, content: [{ type: 'text', text: `${APP_CLOSED} (stale connection info)` }] };
    if (!res.ok) return { isError: true, content: [{ type: 'text', text: `Comfy Atelier error: HTTP ${res.status}` }] };
    return (await res.json()) as McpCallResult;
  }

  async function handle(msg: JsonRpcMessage): Promise<void> {
    const { id, method, params = {} } = msg;
    const isRequest = id !== undefined && id !== null;

    if (method === 'notifications/cancelled') {
      inflight.get(params.requestId as string | number)?.abort();
      return;
    }
    if (!isRequest) return; // other notifications (initialized, etc.)

    switch (method) {
      case 'initialize': {
        const requested = String(params.protocolVersion ?? '');
        reply(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'comfy-atelier', title: 'Comfy Atelier', version: o.version },
          instructions: MCP_INSTRUCTIONS,
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, { tools: mcpToolList() });
        return;
      case 'tools/call': {
        const controller = new AbortController();
        inflight.set(id, controller);
        const progressToken = (params._meta as { progressToken?: string | number } | undefined)?.progressToken;
        let tick = 0;
        const heartbeat =
          progressToken !== undefined
            ? setInterval(() => {
                o.write({
                  jsonrpc: '2.0',
                  method: 'notifications/progress',
                  params: { progressToken, progress: ++tick, message: 'Comfy Atelier is working…' },
                });
              }, o.heartbeatMs ?? 10_000)
            : null;
        try {
          const result = await callApp(String(params.name ?? ''), params.arguments, controller.signal);
          if (!controller.signal.aborted) reply(id, result);
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          inflight.delete(id);
        }
        return;
      }
      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  }

  return {
    handle,
    /** Parse one line from stdin. */
    async handleLine(line: string): Promise<void> {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        fail(null, -32700, 'Parse error');
        return;
      }
      await handle(msg);
    },
    close(): void {
      for (const c of inflight.values()) c.abort();
    },
  };
}
