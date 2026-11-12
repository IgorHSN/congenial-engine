import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClaudeEvent, Settings } from '@shared/types';
import { ClaudeAgent } from '../src/main/claude/agent';
import { ComfyClient } from '../src/main/comfy/client';
import { ModelInventory } from '../src/main/comfy/inventory';
import { ComfyProcess } from '../src/main/comfy/process';
import { defaultSettings } from '../src/main/settings';
import { CivitaiClient } from '../src/main/sources/civitai';
import { Downloader } from '../src/main/sources/downloader';
import { HuggingFaceClient } from '../src/main/sources/huggingface';
import { WorkspaceStore } from '../src/main/workspaces';

type Block = Record<string, unknown>;

/** Serialize an assistant message as the Messages API SSE stream. */
function sse(blocks: Block[], stopReason: string): string {
  const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev('message_start', {
    message: {
      id: `msg_${Math.random().toString(36).slice(2)}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      out += ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      out += ev('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    } else if (b.type === 'thinking') {
      out += ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      out += ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      out += ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'sig-123' } });
    } else if (b.type === 'tool_use') {
      out += ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      out += ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    out += ev('content_block_stop', { index });
  });
  out += ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
  out += ev('message_stop', {});
  return out;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

async function fakeAnthropic(script: Array<{ blocks: Block[]; stop: string }>) {
  const requests: Array<{ body: Record<string, unknown>; headers: IncomingMessage['headers'] }> = [];
  const server = createServer(async (req, res) => {
    const body = await readJson(req);
    requests.push({ body, headers: req.headers });
    const step = script[requests.length - 1];
    if (!step) {
      res.writeHead(500);
      return res.end('no more script');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(step.blocks, step.stop));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function makeAgent(baseURL: string, onEvent: (e: ClaudeEvent, agent: ClaudeAgent) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), 'atelier-agent-'));
  const settings: Settings = defaultSettings('/tmp');
  settings.comfy.url = 'http://127.0.0.1:1'; // unreachable on purpose
  const workspaces = new WorkspaceStore(dataDir);
  let agent!: ClaudeAgent;
  agent = new ClaudeAgent({
    dataDir,
    settings: () => settings,
    apiKey: () => 'sk-ant-test',
    emit: (e) => onEvent(e, agent),
    createClient: (apiKey) => new Anthropic({ apiKey, baseURL, maxRetries: 0 }),
    toolContext: {
      settings: () => settings,
      comfy: new ComfyClient(() => settings.comfy.url),
      process: new ComfyProcess(() => settings),
      inventory: new ModelInventory(dataDir, () => settings.comfy.rootPath),
      civitai: new CivitaiClient(() => undefined),
      hf: new HuggingFaceClient(() => undefined),
      downloader: new Downloader(),
      workspaces,
      setActiveWorkspace: async () => undefined,
      previewImage: async () => null,
    },
  });
  return { agent, settings };
}

describe('ClaudeAgent loop (fake Messages API)', () => {
  it('streams, runs tools, sends results back verbatim and persists the transcript', async () => {
    const api = await fakeAnthropic([
      {
        blocks: [
          { type: 'thinking', thinking: 'Check ComfyUI first.' },
          { type: 'text', text: 'Vou verificar.' },
          { type: 'tool_use', id: 'toolu_1', name: 'comfy_status', input: {} },
          { type: 'tool_use', id: 'toolu_2', name: 'list_workspaces', input: {} },
        ],
        stop: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'O ComfyUI está desligado.' }], stop: 'end_turn' },
    ]);
    const events: ClaudeEvent[] = [];
    const { agent } = makeAgent(api.url, (e) => events.push(e));
    await agent.load();
    await agent.send('Verifique minha instalação');

    expect(api.requests).toHaveLength(2);
    const first = api.requests[0];
    expect(first.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(first.body).toMatchObject({
      model: 'claude-opus-5-5',
      fallbacks: 'default',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      stream: true,
    });
    const tools = first.body.tools as Array<{ name: string; eager_input_streaming: boolean }>;
    expect(tools.length).toBeGreaterThan(10);
    expect(tools.every((t) => t.eager_input_streaming)).toBe(true);

    // Second request: assistant turn replayed verbatim (thinking + signature) + both tool results in one user message.
    const msgs = api.requests[1].body.messages as Array<{ role: string; content: Array<Record<string, unknown>> | string }>;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const assistant = msgs[1].content as Array<Record<string, unknown>>;
    expect(assistant[0]).toMatchObject({ type: 'thinking', thinking: 'Check ComfyUI first.', signature: 'sig-123' });
    const results = msgs[2].content as Array<Record<string, unknown>>;
    expect(results.map((r) => r.tool_use_id)).toEqual(['toolu_1', 'toolu_2']);
    expect(JSON.parse(results[0].content as string)).toMatchObject({ reachable: false });
    // System prompt and tools are byte-identical across turns (prompt cache / preserved thinking).
    expect(api.requests[1].body.system).toEqual(first.body.system);
    expect(JSON.stringify(api.requests[1].body.tools)).toBe(JSON.stringify(first.body.tools));

    expect(events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text)).toEqual([
      'Vou verificar.',
      'O ComfyUI está desligado.',
    ]);
    expect(events.at(-1)).toEqual({ type: 'turn-end', stopReason: 'end_turn' });

    const kinds = agent.transcript().map((i) => i.kind);
    expect(kinds).toEqual(['user', 'thinking', 'assistant-text', 'tool', 'tool', 'assistant-text']);

    // Persisted: a new agent instance sees the same conversation.
    expect(agent.busy).toBe(false);
  });

  it('pauses for approval and reports denial to Claude', async () => {
    const api = await fakeAnthropic([
      {
        blocks: [{ type: 'tool_use', id: 'toolu_9', name: 'run_command', input: { command: 'git pull', reason: 'Atualizar o ComfyUI' } }],
        stop: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Ok, não vou atualizar.' }], stop: 'end_turn' },
    ]);
    const seen: ClaudeEvent[] = [];
    const { agent } = makeAgent(api.url, (e, a) => {
      seen.push(e);
      if (e.type === 'approval') setTimeout(() => a.respondApproval(e.request.requestId, false), 5);
    });
    await agent.load();
    await agent.send('atualize o comfy');
    const approval = seen.find((e) => e.type === 'approval');
    expect(approval && approval.type === 'approval' && approval.request.details).toContain('$ git pull');
    const results = (api.requests[1].body.messages as Array<{ content: Array<Record<string, unknown>> }>)[2].content;
    expect(results[0]).toMatchObject({ tool_use_id: 'toolu_9', is_error: true });
    expect(String(results[0].content)).toMatch(/^USER_DENIED/);
    const tool = agent.transcript().find((i) => i.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.call.status).toBe('denied');
  });

  it('rejects invalid tool input without running the tool', async () => {
    const api = await fakeAnthropic([
      { blocks: [{ type: 'tool_use', id: 'toolu_x', name: 'delete_model', input: { folder: 'not-a-folder' } }], stop: 'tool_use' },
      { blocks: [{ type: 'text', text: 'Corrigindo.' }], stop: 'end_turn' },
    ]);
    const { agent } = makeAgent(api.url, () => undefined);
    await agent.load();
    await agent.send('apague');
    const results = (api.requests[1].body.messages as Array<{ content: Array<Record<string, unknown>> }>)[2].content;
    expect(results[0]).toMatchObject({ is_error: true });
    expect(String(results[0].content)).toContain('INVALID_INPUT');
  });

  it('surfaces API errors as notices', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => server.close());
    const events: ClaudeEvent[] = [];
    const { agent } = makeAgent(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, (e) => events.push(e));
    await agent.load();
    await agent.send('oi');
    const notice = events.find((e) => e.type === 'notice');
    expect(notice && notice.type === 'notice' && notice.text).toMatch(/API key/);
    expect(events.at(-1)?.type).toBe('turn-end');
  });
});
