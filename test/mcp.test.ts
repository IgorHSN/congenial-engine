import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalRequest, McpActivity, Settings } from '@shared/types';
import { TOOLS, type ToolContext } from '../src/main/claude/tools';
import { ComfyClient } from '../src/main/comfy/client';
import { ModelInventory } from '../src/main/comfy/inventory';
import { ComfyProcess } from '../src/main/comfy/process';
import { createBridge } from '../src/main/mcp/bridge';
import { claudeCodeCommand, desktopConfigPath, installInDesktopConfig, SERVER_NAME } from '../src/main/mcp/clientConfig';
import { MCP_ENDPOINT_FILE, McpHost } from '../src/main/mcp/host';
import { defaultSettings } from '../src/main/settings';
import { CivitaiClient } from '../src/main/sources/civitai';
import { Downloader } from '../src/main/sources/downloader';
import { HuggingFaceClient } from '../src/main/sources/huggingface';
import { WorkspaceStore } from '../src/main/workspaces';
import { startFakeComfy } from './helpers/fakeServers';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

async function startHost(opts: { approve?: boolean; downloader?: Downloader } = {}) {
  const comfyServer = await startFakeComfy();
  cleanups.push(comfyServer.close);
  const dataDir = tmp('atelier-mcp-data-');
  const root = tmp('atelier-mcp-root-');
  writeFileSync(join(root, 'main.py'), '');
  mkdirSync(join(root, 'models', 'loras'), { recursive: true });
  writeFileSync(join(root, 'models', 'loras', 'style.safetensors'), 'x');
  const settings: Settings = defaultSettings(tmp('atelier-mcp-pics-'));
  settings.comfy.url = comfyServer.url;
  settings.comfy.rootPath = root;
  const workspaces = new WorkspaceStore(dataDir);
  await workspaces.load();
  const approvals: Array<Omit<ApprovalRequest, 'requestId' | 'toolUseId'>> = [];
  const activity: McpActivity[] = [];
  const toolContext: Omit<ToolContext, 'approve' | 'signal' | 'background'> = {
    settings: () => settings,
    comfy: new ComfyClient(() => settings.comfy.url),
    process: new ComfyProcess(() => settings),
    inventory: new ModelInventory(dataDir, () => root),
    civitai: new CivitaiClient(() => undefined),
    hf: new HuggingFaceClient(() => undefined),
    downloader: opts.downloader ?? new Downloader(),
    workspaces,
    setActiveWorkspace: async (id) => {
      settings.generation.activeWorkspaceId = id;
    },
    previewImage: async () => null,
  };
  const host = new McpHost({
    dataDir,
    toolContext,
    preferredPort: 0,
    approve: async (req) => {
      approvals.push(req);
      return opts.approve ?? false;
    },
    onActivity: (a) => activity.push(a),
  });
  const port = await host.start();
  cleanups.push(() => host.stop());
  const endpoint = JSON.parse(readFileSync(join(dataDir, MCP_ENDPOINT_FILE), 'utf8')) as { port: number; token: string };
  const call = (name: string, args: unknown, headers: Record<string, string> = { authorization: `Bearer ${endpoint.token}` }) =>
    fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name, arguments: args }) });
  return { host, port, endpoint, dataDir, root, settings, workspaces, approvals, activity, call };
}

describe('McpHost', () => {
  it('requires the token and rejects browsers', async () => {
    const h = await startHost();
    expect((await fetch(`http://127.0.0.1:${h.port}/tools`)).status).toBe(401);
    const fromBrowser = await fetch(`http://127.0.0.1:${h.port}/tools`, {
      headers: { authorization: `Bearer ${h.endpoint.token}`, origin: 'https://evil.example' },
    });
    expect(fromBrowser.status).toBe(403);
    const ok = await fetch(`http://127.0.0.1:${h.port}/tools`, { headers: { authorization: `Bearer ${h.endpoint.token}` } });
    const body = (await ok.json()) as { tools: Array<{ name: string; inputSchema: { type: string } }> };
    expect(body.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(body.tools.every((t) => t.inputSchema.type === 'object')).toBe(true);
  });

  it('runs tools, reports activity, and routes approvals to the app', async () => {
    const h = await startHost({ approve: false });
    const status = (await (await h.call('comfy_status', {})).json()) as { content: Array<{ text: string }>; isError?: boolean };
    expect(status.isError).toBeUndefined();
    expect(JSON.parse(status.content[0].text)).toMatchObject({ reachable: true });
    expect(h.activity.map((a) => a.phase)).toEqual(['start', 'end']);

    const denied = (await (await h.call('delete_model', { folder: 'loras', file: 'style.safetensors' })).json()) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toMatch(/^USER_DENIED/);
    expect(h.approvals[0].title).toContain('style.safetensors');
    expect(existsSync(join(h.root, 'models', 'loras', 'style.safetensors'))).toBe(true);

    const bad = (await (await h.call('delete_model', { folder: 'nope' })).json()) as { isError?: boolean; content: Array<{ text: string }> };
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('INVALID_INPUT');
  });

  it('starts downloads in the background for MCP clients', async () => {
    let finish!: () => void;
    const stub = {
      enqueue: (req: { dest: string }) => ({
        id: 'dl-1',
        done: new Promise((resolve) => {
          finish = () => {
            writeFileSync(req.dest, 'bytes');
            resolve({ state: 'done', receivedBytes: 5 });
          };
        }),
      }),
      list: () => [],
    } as unknown as Downloader;
    const h = await startHost({ approve: true, downloader: stub });
    const res = (await (
      await h.call('download_model', { source: 'url', url: 'https://example.invalid/new_lora.safetensors', folder: 'loras', trigger_words: ['nl'] })
    ).json()) as { content: Array<{ text: string }> };
    expect(JSON.parse(res.content[0].text)).toMatchObject({ status: 'downloading', downloadId: 'dl-1', file: 'new_lora.safetensors' });
    finish();
    await new Promise((r) => setTimeout(r, 50));
    const inv = new ModelInventory(h.dataDir, () => h.root);
    expect((await inv.getMeta('loras', 'new_lora.safetensors')).triggerWords).toEqual(['nl']);
  });

  it('removes the endpoint file when stopped', async () => {
    const h = await startHost();
    await h.host.stop();
    expect(existsSync(join(h.dataDir, MCP_ENDPOINT_FILE))).toBe(false);
  });
});

/** Connect an official MCP SDK client to the bridge in memory. */
async function sdkClientFor(dataDir: string) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const bridge = createBridge({ dataDir, version: 'test', write: (msg) => void serverSide.send(msg as JSONRPCMessage), heartbeatMs: 20 });
  serverSide.onmessage = (msg) => void bridge.handle(msg as never);
  await serverSide.start();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientSide);
  cleanups.push(() => client.close());
  return client;
}

describe('MCP bridge (official SDK client)', () => {
  it('handshakes, lists tools with instructions, and forwards calls to the app', async () => {
    const h = await startHost();
    const client = await sdkClientFor(h.dataDir);
    expect(client.getServerVersion()).toMatchObject({ name: 'comfy-atelier' });
    expect(client.getInstructions()).toContain('Comfy Atelier');
    const { tools } = await client.listTools();
    expect(tools.length).toBe(TOOLS.length);
    const res = await client.callTool({ name: 'list_models', arguments: { folder: 'loras' } });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    expect(JSON.parse(text).models[0].file).toBe('style.safetensors');
  });

  it('explains that the app must be open', async () => {
    const client = await sdkClientFor(tmp('atelier-closed-'));
    const res = await client.callTool({ name: 'comfy_status', arguments: {} });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0].text).toMatch(/not open/);
  });
});

describe('MCP bridge over stdio (built bundle)', () => {
  const bridgePath = join(__dirname, '..', 'out', 'main', 'bridge.js');
  beforeAll(() => {
    execSync('npx electron-vite build', { cwd: join(__dirname, '..'), stdio: 'ignore' });
  }, 120_000);

  it('works as a real stdio MCP server', async () => {
    const h = await startHost();
    const transport = new StdioClientTransport({ command: process.execPath, args: [bridgePath, '--data-dir', h.dataDir], stderr: 'pipe' });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    await client.connect(transport);
    cleanups.push(() => client.close());
    const { tools } = await client.listTools();
    expect(tools.some((t) => t.name === 'save_workspace')).toBe(true);
    const res = await client.callTool({ name: 'save_workspace', arguments: { name: 'Via MCP', base_model: 'sdxl', checkpoint: 'x.safetensors' } });
    expect(res.isError).toBeFalsy();
    expect(h.workspaces.list().map((w) => w.name)).toEqual(['Via MCP']);
  }, 30_000);
});

describe('client config', () => {
  const launch = { command: 'C:\\Program Files\\Comfy Atelier\\Comfy Atelier.exe', bridgePath: 'C:\\app\\out\\main\\bridge.js', dataDir: 'C:\\Users\\me\\AppData\\Roaming\\Comfy Atelier' };

  it('merges into an existing Claude Desktop config with a backup', async () => {
    const dir = tmp('atelier-desktop-');
    const path = join(dir, 'claude_desktop_config.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
    const res = await installInDesktopConfig(path, launch);
    const cfg = JSON.parse(readFileSync(path, 'utf8'));
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcpServers.other).toEqual({ command: 'x' });
    expect(cfg.mcpServers[SERVER_NAME]).toEqual({
      command: launch.command,
      args: [launch.bridgePath, '--data-dir', launch.dataDir],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(res.backup && existsSync(res.backup)).toBe(true);
  });

  it('creates the file when missing and refuses invalid JSON', async () => {
    const dir = tmp('atelier-desktop-');
    const fresh = join(dir, 'sub', 'claude_desktop_config.json');
    expect((await installInDesktopConfig(fresh, launch)).created).toBe(true);
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json');
    await expect(installInDesktopConfig(broken, launch)).rejects.toThrow(/JSON/);
    expect(readFileSync(broken, 'utf8')).toBe('{ not json');
    expect(readdirSync(dir).filter((f) => f.startsWith('broken.json.bak'))).toHaveLength(0);
  });

  it('builds the Claude Code command and config paths', () => {
    expect(claudeCodeCommand(launch)).toBe(
      'claude mcp add comfy-atelier --scope user --env ELECTRON_RUN_AS_NODE=1 -- "C:\\Program Files\\Comfy Atelier\\Comfy Atelier.exe" "C:\\app\\out\\main\\bridge.js" --data-dir "C:\\Users\\me\\AppData\\Roaming\\Comfy Atelier"',
    );
    expect(desktopConfigPath('win32', { APPDATA: 'C:\\AppData' }, 'C:\\Users\\me')).toContain('Claude');
    expect(desktopConfigPath('darwin', {}, '/Users/me')).toBe('/Users/me/Library/Application Support/Claude/claude_desktop_config.json');
    expect(desktopConfigPath('linux', {}, '/home/me')).toBe('/home/me/.config/Claude/claude_desktop_config.json');
  });
});
