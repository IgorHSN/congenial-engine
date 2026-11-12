import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GenEntry, GenEvent, Settings } from '@shared/types';
import { TOOL_PARAMS, TOOLS, toolByName, type ToolContext } from '../src/main/claude/tools';
import { toTranscript } from '../src/main/claude/transcript';
import { ComfyClient, ComfyError } from '../src/main/comfy/client';
import { ModelInventory } from '../src/main/comfy/inventory';
import { ComfyProcess } from '../src/main/comfy/process';
import { LocalLlm } from '../src/main/generation/llm';
import { GenerationSession } from '../src/main/generation/session';
import { defaultSettings, SettingsStore } from '../src/main/settings';
import { CivitaiClient } from '../src/main/sources/civitai';
import { Downloader } from '../src/main/sources/downloader';
import { HuggingFaceClient } from '../src/main/sources/huggingface';
import { WorkspaceStore } from '../src/main/workspaces';
import { startFakeComfy, startFakeOllama, startFileServer, TINY_PNG } from './helpers/fakeServers';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeComfyRoot(): string {
  const root = tempDir('atelier-comfy-');
  writeFileSync(join(root, 'main.py'), '');
  for (const f of ['checkpoints', 'loras', 'vae']) mkdirSync(join(root, 'models', f), { recursive: true });
  writeFileSync(join(root, 'models', 'checkpoints', 'ponyV6.safetensors'), 'x');
  writeFileSync(join(root, 'models', 'loras', 'watercolor.safetensors'), 'x');
  return root;
}

async function setup(opts: { llmReply?: (m: Array<{ role: string; content: string }>) => string; failValidation?: boolean } = {}) {
  const comfyServer = await startFakeComfy({ failValidation: opts.failValidation });
  cleanups.push(comfyServer.close);
  const ollama = await startFakeOllama(
    opts.llmReply ??
      (() =>
        JSON.stringify({
          positive: '1girl, elf, warrior, sunset, golden light',
          negative: 'extra arms',
          aspect: 'portrait',
          batch_size: 2,
          seed: null,
          loras: [{ file: 'watercolor.safetensors', strength: 0.7 }],
          comment: 'Gerei uma guerreira élfica ao pôr do sol.',
          refused: false,
        })),
  );
  cleanups.push(ollama.close);

  const dataDir = tempDir('atelier-data-');
  const root = makeComfyRoot();
  const settings: Settings = defaultSettings(tempDir('atelier-pics-'));
  settings.comfy.url = comfyServer.url;
  settings.comfy.rootPath = root;
  settings.localLlm.baseUrl = ollama.url;
  settings.localLlm.model = 'fake-llm:8b';

  const comfy = new ComfyClient(() => settings.comfy.url);
  const inventory = new ModelInventory(dataDir, () => root);
  await inventory.setMeta('loras', 'watercolor.safetensors', { triggerWords: ['wtrcolor'], description: 'watercolor style', baseModel: 'pony' });
  const workspaces = new WorkspaceStore(dataDir);
  await workspaces.load();
  const ws = await workspaces.save({
    name: 'Pony anime',
    baseModel: 'pony',
    checkpoint: 'ponyV6.safetensors',
    optionalLoras: [{ file: 'watercolor.safetensors', strength: 0.8 }],
  });
  settings.generation.activeWorkspaceId = ws.id;

  const events: GenEvent[] = [];
  const session = new GenerationSession({
    dataDir,
    settings: () => settings,
    comfy,
    llm: new LocalLlm(() => settings.localLlm),
    inventory,
    workspaces,
    emit: (e) => events.push(e),
  });
  await session.load();
  return { comfyServer, ollama, settings, comfy, inventory, workspaces, ws, session, events, dataDir, root };
}

describe('generation chat end-to-end (fake Ollama + fake ComfyUI)', () => {
  it('refines, builds the workflow, runs it and saves the images', async () => {
    const t = await setup();
    await t.session.send('uma guerreira élfica ao pôr do sol, estilo aquarela');

    // LLM request: JSON schema, keep_alive 0, system prompt for Pony
    expect(t.ollama.requests).toHaveLength(1);
    const req = t.ollama.requests[0];
    expect(req.model).toBe('fake-llm:8b');
    expect(req.keep_alive).toBe(0);
    expect(req.format).toMatchObject({ type: 'object' });
    expect(req.messages[0].content).toContain('Pony Diffusion');
    expect(req.messages[0].content).toContain('wtrcolor');

    // ComfyUI received the graph with prefix + trigger word + LoRA + portrait size + batch 2
    expect(t.comfyServer.prompts).toHaveLength(1);
    const graph = Object.values(t.comfyServer.prompts[0]);
    const texts = graph.filter((n) => n.class_type === 'CLIPTextEncode').map((n) => n.inputs.text as string);
    expect(texts[0]).toBe('score_9, score_8_up, score_7_up, wtrcolor, 1girl, elf, warrior, sunset, golden light');
    expect(texts[1]).toContain('score_4');
    expect(texts[1]).toContain('extra arms');
    expect(graph.find((n) => n.class_type === 'LoraLoader')?.inputs).toMatchObject({ lora_name: 'watercolor.safetensors', strength_model: 0.7 });
    expect(graph.find((n) => n.class_type === 'EmptyLatentImage')?.inputs).toMatchObject({ width: 832, height: 1216, batch_size: 2 });

    const result = t.session.history().find((e): e is Extract<GenEntry, { kind: 'result' }> => e.kind === 'result')!;
    expect(result.job.status).toBe('done');
    expect(result.job.images).toHaveLength(2);
    for (const p of result.job.images) expect(readFileSync(p).equals(TINY_PNG)).toBe(true);
    expect(result.refined.comment).toContain('élfica');
    expect(t.events.some((e) => e.type === 'entry-update' && e.entry.kind === 'result' && e.entry.job.progress > 0)).toBe(true);

    // Iteration: the second request carries the previous turn as assistant JSON
    await t.session.send('agora à noite');
    expect(t.ollama.requests[1].messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);

    // Variation re-runs the same prompt with a new seed without calling the LLM
    await t.session.rerun(result.id, true);
    expect(t.ollama.requests).toHaveLength(2);
    expect(t.comfyServer.prompts).toHaveLength(3);
  });

  it('blocks unsafe prompts before they reach ComfyUI, even if the LLM complies', async () => {
    const t = await setup({
      llmReply: () => JSON.stringify({ positive: 'loli, nude', negative: '', aspect: 'square', comment: '', refused: false }),
    });
    await t.session.send('qualquer coisa');
    expect(t.comfyServer.prompts).toHaveLength(0);
    const notice = t.session.history().find((e) => e.kind === 'notice');
    expect(notice && notice.kind === 'notice' && notice.text).toMatch(/bloqueado/);
  });

  it('adds the safety negative for sexual prompts', async () => {
    const t = await setup({
      llmReply: () =>
        JSON.stringify({ positive: '1woman, adult, nude, bedroom, rating_explicit', negative: '', aspect: 'square', comment: 'ok', refused: false }),
    });
    await t.session.send('mulher adulta nua no quarto');
    const graph = Object.values(t.comfyServer.prompts[0]);
    const neg = graph.filter((n) => n.class_type === 'CLIPTextEncode')[1].inputs.text as string;
    expect(neg).toContain('loli');
  });

  it('shows the refusal from the local LLM', async () => {
    const t = await setup({
      llmReply: () => JSON.stringify({ positive: '', negative: '', aspect: 'square', comment: '', refused: true, refusal_reason: 'Pessoa real identificável.' }),
    });
    await t.session.send('foto nua de uma celebridade');
    expect(t.comfyServer.prompts).toHaveLength(0);
    expect(t.session.history().some((e) => e.kind === 'notice' && e.text === 'Pessoa real identificável.')).toBe(true);
  });

  it('raw mode skips the LLM', async () => {
    const t = await setup();
    await t.session.send('/raw 1girl, solo, smile');
    expect(t.ollama.requests).toHaveLength(0);
    const texts = Object.values(t.comfyServer.prompts[0])
      .filter((n) => n.class_type === 'CLIPTextEncode')
      .map((n) => n.inputs.text);
    expect(texts[0]).toBe('score_9, score_8_up, score_7_up, 1girl, solo, smile');
  });
});

describe('ComfyClient', () => {
  it('formats node validation errors', async () => {
    const server = await startFakeComfy({ failValidation: true });
    cleanups.push(server.close);
    const client = new ComfyClient(() => server.url);
    await expect(client.run({ '1': { class_type: 'CheckpointLoaderSimple', inputs: {} } })).rejects.toThrow(
      /CheckpointLoaderSimple.*Value not in list/s,
    );
  });

  it('reports an unreachable server', async () => {
    const client = new ComfyClient(() => 'http://127.0.0.1:1');
    await expect(client.systemStats()).rejects.toBeInstanceOf(ComfyError);
  });
});

describe('Downloader', () => {
  it('downloads, verifies sha256 and renames atomically', async () => {
    const data = Buffer.alloc(300_000, 7);
    const files = await startFileServer({ '/m.safetensors': data });
    cleanups.push(files.close);
    const dir = tempDir('atelier-dl-');
    const dl = new Downloader();
    const sha = createHash('sha256').update(data).digest('hex');
    const ok = await dl.enqueue({ label: 'm', url: `${files.url}/m.safetensors`, folder: 'loras', file: 'm.safetensors', dest: join(dir, 'm.safetensors'), expectedSha256: sha }).done;
    expect(ok.state).toBe('done');
    expect(readFileSync(join(dir, 'm.safetensors')).length).toBe(300_000);

    const bad = await dl.enqueue({ label: 'b', url: `${files.url}/m.safetensors`, folder: 'loras', file: 'b.safetensors', dest: join(dir, 'b.safetensors'), expectedSha256: 'deadbeef' }).done;
    expect(bad.state).toBe('error');
    expect(existsSync(join(dir, 'b.safetensors'))).toBe(false);
    expect(existsSync(join(dir, 'b.safetensors.part'))).toBe(false);

    const missing = await dl.enqueue({ label: 'x', url: `${files.url}/nope`, folder: 'loras', file: 'x', dest: join(dir, 'x') }).done;
    expect(missing.state).toBe('error');
    expect(missing.error).toContain('404');
  });
});

describe('Claude tools', () => {
  async function toolCtx(approve: boolean) {
    const t = await setup();
    const approvals: string[] = [];
    const ctx: ToolContext = {
      settings: () => t.settings,
      comfy: t.comfy,
      process: new ComfyProcess(() => t.settings),
      inventory: t.inventory,
      civitai: new CivitaiClient(() => undefined),
      hf: new HuggingFaceClient(() => undefined),
      downloader: new Downloader(),
      workspaces: t.workspaces,
      approve: async (req) => {
        approvals.push(req.title);
        return approve;
      },
      setActiveWorkspace: async (id) => {
        t.settings.generation.activeWorkspaceId = id;
      },
      previewImage: async () => ({ data: 'AAAA', mediaType: 'image/jpeg' }),
      signal: new AbortController().signal,
    };
    return { t, ctx, approvals };
  }

  const run = (name: string, input: unknown, ctx: ToolContext) => {
    const def = toolByName(name)!;
    const parsed = def.schema.parse(input);
    return (def.run as (i: unknown, c: ToolContext) => Promise<unknown>)(parsed, ctx);
  };

  it('exposes JSON schemas for every tool', () => {
    expect(TOOL_PARAMS).toHaveLength(TOOLS.length);
    for (const t of TOOL_PARAMS) {
      expect(t.input_schema.type).toBe('object');
      expect(t.eager_input_streaming).toBe(true);
      expect(JSON.stringify(t.input_schema)).not.toContain('$schema');
    }
    expect(new Set(TOOL_PARAMS.map((t) => t.name)).size).toBe(TOOL_PARAMS.length);
  });

  it('comfy_status and list_models read the fake install', async () => {
    const { ctx } = await toolCtx(true);
    const status = JSON.parse((await run('comfy_status', {}, ctx)) as string);
    expect(status.reachable).toBe(true);
    expect(status.devices[0].name).toContain('Fake GPU');
    expect(status.modelCounts).toEqual({ checkpoints: 1, loras: 1 });
    const models = JSON.parse((await run('list_models', { folder: 'loras' }, ctx)) as string);
    expect(models.models[0]).toMatchObject({ file: 'watercolor.safetensors', triggerWords: ['wtrcolor'] });
  });

  it('download_model asks for approval and installs with metadata', async () => {
    const files = await startFileServer({ '/files/cool_style.safetensors': Buffer.from('lora-bytes') });
    cleanups.push(files.close);

    // Denied: nothing is fetched.
    const denied = await toolCtx(false);
    const res = await run(
      'download_model',
      { source: 'url', url: `${files.url.replace('http:', 'https:')}/files/cool_style.safetensors`, folder: 'loras' },
      denied.ctx,
    );
    expect(res).toMatch(/^USER_DENIED/);

    // Plain http is rejected for direct URLs.
    await expect(run('download_model', { source: 'url', url: `${files.url}/files/cool_style.safetensors`, folder: 'loras' }, denied.ctx)).rejects.toThrow(
      /https/,
    );

    // Approved: the (stubbed) downloader writes the file and metadata is recorded.
    const { t, ctx, approvals } = await toolCtx(true);
    const out = await run(
      'download_model',
      {
        source: 'url',
        url: `https://example.invalid/cool_style.safetensors`,
        folder: 'loras',
        base_model: 'pony',
        trigger_words: ['cool style'],
      },
      {
        ...ctx,
        downloader: {
          enqueue: (req: Parameters<Downloader['enqueue']>[0]) => {
            writeFileSync(req.dest, 'lora-bytes');
            return { id: 'dl1', done: Promise.resolve({ ...req, id: 'dl1', state: 'done', receivedBytes: 10, totalBytes: 10, bytesPerSecond: 0, startedAt: '' }) };
          },
        } as unknown as Downloader,
      },
    );
    expect(approvals).toHaveLength(1);
    const parsed = JSON.parse(out as string);
    expect(parsed).toMatchObject({ status: 'installed', folder: 'loras', file: 'cool_style.safetensors' });
    expect(existsSync(join(t.root, 'models', 'loras', 'cool_style.safetensors'))).toBe(true);
    const meta = await t.inventory.getMeta('loras', 'cool_style.safetensors');
    expect(meta).toMatchObject({ baseModel: 'pony', triggerWords: ['cool style'] });
  });

  it('save_workspace fills defaults and reports missing files; test_workspace runs it', async () => {
    const { t, ctx } = await toolCtx(true);
    const saved = JSON.parse(
      (await run(
        'save_workspace',
        { name: 'Illustrious', base_model: 'illustrious', checkpoint: 'missing.safetensors', loras: [{ file: 'watercolor.safetensors', strength: 0.5 }], set_active: true },
        ctx,
      )) as string,
    );
    expect(saved.saved.positivePrefix).toContain('masterpiece');
    expect(saved.saved.defaults.clipSkip).toBe(2);
    expect(saved.missingFiles).toEqual(['checkpoints/missing.safetensors']);
    expect(t.settings.generation.activeWorkspaceId).toBe(saved.saved.id);

    const result = (await run('test_workspace', { id: t.ws.id, prompt: 'a red apple on a table' }, ctx)) as Array<{ type: string; text?: string }>;
    expect(Array.isArray(result)).toBe(true);
    expect(JSON.parse(result[0].text!)).toMatchObject({ ok: true });
    expect(result[1].type).toBe('image');
  });

  it('delete_model respects a denial', async () => {
    const { t, ctx } = await toolCtx(false);
    const out = await run('delete_model', { folder: 'loras', file: 'watercolor.safetensors' }, ctx);
    expect(out).toMatch(/^USER_DENIED/);
    expect(existsSync(join(t.root, 'models', 'loras', 'watercolor.safetensors'))).toBe(true);
  });

  it('comfy_node_info describes combo inputs', async () => {
    const { ctx } = await toolCtx(true);
    const info = JSON.parse((await run('comfy_node_info', { node_class: 'KSampler' }, ctx)) as string);
    expect(info.required.sampler_name.options).toEqual(['euler', 'dpmpp_2m']);
    expect(info.required.steps).toMatchObject({ type: 'INT', default: 20 });
  });
});

describe('transcript', () => {
  it('pairs tool calls with results and hides empty thinking', () => {
    const items = toTranscript([
      { role: 'user', content: 'instale' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 's' },
          { type: 'text', text: 'Vou baixar.' },
          { type: 'tool_use', id: 't1', name: 'download_model', input: { source: 'civitai' } },
          { type: 'tool_use', id: 't2', name: 'delete_model', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: '{"status":"installed"}' },
          { type: 'tool_result', tool_use_id: 't2', content: 'USER_DENIED: no', is_error: true },
        ],
      },
    ]);
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant-text', 'tool', 'tool']);
    const tools = items.filter((i) => i.kind === 'tool');
    expect(tools.map((i) => (i.kind === 'tool' ? i.call.status : ''))).toEqual(['done', 'denied']);
  });
});

describe('SettingsStore', () => {
  it('persists settings and encrypts secrets', async () => {
    const dir = tempDir('atelier-settings-');
    const codec = { isAvailable: () => true, encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.slice(4) };
    const store = new SettingsStore(dir, defaultSettings('/pics'), codec);
    await store.load();
    await store.update({ comfy: { url: 'http://localhost:9000' } });
    await store.setSecret('anthropicApiKey', ' sk-ant-test ');
    const raw = readFileSync(join(dir, 'secrets.json'), 'utf8');
    expect(raw).toContain('enc:sk-ant-test');

    const again = new SettingsStore(dir, defaultSettings('/pics'), codec);
    await again.load();
    expect(again.get().comfy.url).toBe('http://localhost:9000');
    expect(again.get().comfy.rootPath).toBe('');
    expect(again.getSecret('anthropicApiKey')).toBe('sk-ant-test');
    expect(again.getPublic().secrets).toEqual({ anthropicApiKey: true, civitaiToken: !!process.env.CIVITAI_TOKEN, huggingfaceToken: !!process.env.HF_TOKEN });
    await again.setSecret('anthropicApiKey', '');
    expect(again.getPublic().secrets.anthropicApiKey).toBe(!!process.env.ANTHROPIC_API_KEY);
  });
});
