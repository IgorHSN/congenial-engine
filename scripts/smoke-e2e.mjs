// End-to-end smoke test: launches the built Electron app against fake ComfyUI + Ollama
// servers, sends two requests in the generation chat and saves screenshots.
//
//   npm run build && npm run smoke            (Linux CI: xvfb-run -a npm run smoke)
//
// The setup-chat history shown in the screenshot is demo data written to a temp profile;
// no request is sent to the Anthropic API.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const OUT = process.argv[2] ?? join(APP, 'docs');
const require = createRequire(join(APP, 'package.json'));
const { WebSocketServer } = require('ws');
const { _electron: electron } = require('playwright');

// ---- tiny PNG encoder (gradient "painting")
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 4 + 1) + 1 + x * 4;
      const t = y / h;
      const sun = Math.max(0, 1 - Math.hypot(x - w * 0.62, y - h * 0.42) / (w * 0.35));
      const hill = y > h * (0.7 + 0.06 * Math.sin(x / 60 + seed)) ? 1 : 0;
      raw[i] = Math.min(255, (40 + 200 * (1 - t) + 120 * sun) * (hill ? 0.25 : 1));
      raw[i + 1] = Math.min(255, (30 + 110 * (1 - t) + 90 * sun) * (hill ? 0.3 : 1));
      raw[i + 2] = Math.min(255, (90 + 80 * t + 20 * sun) * (hill ? 0.45 : 1));
      raw[i + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const body = async (req) => {
  const c = [];
  for await (const x of req) c.push(x);
  return JSON.parse(Buffer.concat(c).toString() || '{}');
};
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

// ---- fake ComfyUI
const history = new Map();
const sockets = new Map();
let n = 0;
const received = [];
const comfy = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/system_stats')
    return json(res, 200, {
      system: { comfyui_version: '0.9.2', python_version: '3.12.7' },
      devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 4070 : cudaMallocAsync', type: 'cuda', vram_total: 12 * 1024 ** 3, vram_free: 9.4 * 1024 ** 3 }],
    });
  if (url.pathname === '/queue') return json(res, 200, { queue_running: [], queue_pending: [] });
  if (url.pathname === '/prompt') {
    const b = await body(req);
    received.push(b.prompt);
    const id = `p${++n}`;
    json(res, 200, { prompt_id: id, number: n, node_errors: {} });
    const save = Object.entries(b.prompt).find(([, v]) => v.class_type === 'SaveImage')[0];
    const latent = Object.values(b.prompt).find((v) => v.class_type.startsWith('Empty'));
    const ws = sockets.get(b.client_id);
    let step = 0;
    const t = setInterval(() => {
      step++;
      ws?.send(JSON.stringify({ type: 'progress', data: { value: step, max: 10, prompt_id: id } }));
      if (step === 10) {
        clearInterval(t);
        history.set(id, {
          outputs: { [save]: { images: Array.from({ length: latent.inputs.batch_size }, (_, i) => ({ filename: `img_${id}_${i}_${latent.inputs.width}x${latent.inputs.height}.png`, subfolder: '', type: 'output' })) } },
          status: { status_str: 'success', completed: true },
        });
        ws?.send(JSON.stringify({ type: 'executing', data: { node: null, prompt_id: id } }));
      }
    }, 120);
    return;
  }
  const h = url.pathname.match(/^\/history\/(.+)/);
  if (h) return json(res, 200, history.has(h[1]) ? { [h[1]]: history.get(h[1]) } : {});
  if (url.pathname === '/view') {
    const m = url.searchParams.get('filename').match(/_(\d+)_(\d+)x(\d+)/);
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(png(Math.round(Number(m[2]) / 4), Math.round(Number(m[3]) / 4), Number(m[1])));
  }
  json(res, 404, {});
});
const wss = new WebSocketServer({ noServer: true });
comfy.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  wss.handleUpgrade(req, socket, head, (ws) => sockets.set(url.searchParams.get('clientId'), ws));
});
const comfyUrl = await listen(comfy);

// ---- fake Ollama
const llmRequests = [];
const ollama = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/tags') return json(res, 200, { models: [{ name: 'dolphin3:8b' }, { name: 'qwen3:8b' }] });
  if (url.pathname === '/api/chat') {
    const b = await body(req);
    llmRequests.push(b);
    const last = b.messages.at(-1).content;
    const night = /noite/i.test(last);
    return json(res, 200, {
      message: {
        content: JSON.stringify({
          positive: night
            ? '1girl, solo, elf, long silver hair, pointy ears, warrior, ornate armor, holding sword, night, full moon, starry sky, cliff, wind, cinematic lighting, wtrcolor'
            : '1girl, solo, elf, long silver hair, pointy ears, warrior, ornate armor, holding sword, sunset, golden hour, cliff, wind, cinematic lighting, wtrcolor',
          negative: '',
          aspect: 'portrait',
          batch_size: night ? 2 : 1,
          seed: null,
          loras: [{ file: 'watercolor_style_pony.safetensors', strength: 0.7 }],
          comment: night ? 'Mesma cena, agora à noite com lua cheia — 2 variações.' : 'Guerreira élfica ao pôr do sol, com a LoRA de aquarela.',
          refused: false,
        }),
      },
    });
  }
  json(res, 404, {});
});
const ollamaUrl = await listen(ollama);

// ---- user data
const userData = mkdtempSync(join(tmpdir(), 'atelier-e2e-'));
const root = mkdtempSync(join(tmpdir(), 'ComfyUI-'));
writeFileSync(join(root, 'main.py'), '');
for (const f of ['checkpoints', 'loras']) mkdirSync(join(root, 'models', f), { recursive: true });
writeFileSync(join(root, 'models/checkpoints/ponyDiffusionV6XL.safetensors'), 'x');
writeFileSync(join(root, 'models/loras/watercolor_style_pony.safetensors'), 'x');
writeFileSync(join(root, 'models/loras/detail_tweaker_xl.safetensors'), 'x');
writeFileSync(join(root, 'models/loras/film_grain_pony.safetensors'), 'x');
const outDir = join(userData, 'images');
writeFileSync(
  join(userData, 'settings.json'),
  JSON.stringify({
    comfy: { url: comfyUrl, rootPath: root },
    localLlm: { provider: 'ollama', baseUrl: ollamaUrl, model: 'dolphin3:8b' },
    generation: { outputDir: outDir, activeWorkspaceId: 'ws-demo' },
  }),
);
writeFileSync(join(userData, 'secrets.json'), JSON.stringify({ anthropicApiKey: { enc: false, value: 'sk-ant-demo' } }));
writeFileSync(
  join(userData, 'models.json'),
  JSON.stringify({
    'loras/watercolor_style_pony.safetensors': { baseModel: 'pony', triggerWords: ['wtrcolor'], description: 'watercolor painting style' },
    'loras/detail_tweaker_xl.safetensors': { baseModel: 'sdxl', description: 'adds fine detail' },
    'loras/film_grain_pony.safetensors': { baseModel: 'pony', triggerWords: ['film grain'], description: 'analog film grain look' },
  }),
);
writeFileSync(
  join(userData, 'workspaces.json'),
  JSON.stringify([
    {
      id: 'ws-demo', name: 'Pony · Fantasia', description: '', baseModel: 'pony', pipeline: 'checkpoint',
      checkpoint: 'ponyDiffusionV6XL.safetensors', loras: [{ file: 'detail_tweaker_xl.safetensors', strength: 0.6 }],
      optionalLoras: [{ file: 'watercolor_style_pony.safetensors', strength: 0.8 }, { file: 'film_grain_pony.safetensors', strength: 0.5 }],
      defaults: { width: 1024, height: 1024, steps: 28, cfg: 7, sampler: 'euler_ancestral', scheduler: 'normal', batchSize: 1, clipSkip: 2, guidance: 3.5 },
      positivePrefix: 'score_9, score_8_up, score_7_up', negativePrompt: 'score_4, score_5, score_6, worst quality, low quality',
      refinerNotes: 'fantasy illustration', createdAt: '', updatedAt: '',
    },
  ]),
);
// A mocked setup conversation so the left pane has content in the screenshot.
writeFileSync(
  join(userData, 'claude-conversation.json'),
  JSON.stringify({
    messages: [
      { role: 'user', content: 'Instale uma LoRA de aquarela para o Pony e monte um workspace de fantasia.' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Verificar a instalação, buscar LoRAs de aquarela compatíveis com Pony e escolher a mais baixada.', signature: 'x' },
        { type: 'text', text: 'Vou checar sua instalação e procurar LoRAs de aquarela compatíveis com Pony.' },
        { type: 'tool_use', id: 't1', name: 'comfy_status', input: {} },
        { type: 'tool_use', id: 't2', name: 'search_civitai', input: { query: 'watercolor', types: ['LORA'], base_models: ['Pony'] } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: '{"reachable":true,"comfyuiVersion":"0.9.2"}' },
        { type: 'tool_result', tool_use_id: 't2', content: '[{"modelId":1,"name":"Watercolor Style (Pony)"}]' },
      ] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't3', name: 'download_model', input: { source: 'civitai', civitai_version_id: 123, base_model: 'pony', trigger_words: ['wtrcolor'] } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: '{"status":"installed","folder":"loras","file":"watercolor_style_pony.safetensors","sizeMB":217.9}' }] },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't4', name: 'save_workspace', input: { name: 'Pony · Fantasia', base_model: 'pony', checkpoint: 'ponyDiffusionV6XL.safetensors' } },
        { type: 'tool_use', id: 't5', name: 'test_workspace', input: { id: 'ws-demo', prompt: 'a red apple on a wooden table' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't4', content: '{"saved":{"id":"ws-demo"}}' },
        { type: 'tool_result', tool_use_id: 't5', content: '{"ok":true,"seconds":7.9}' },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'Pronto:\n\n- **LoRA instalada:** `loras/watercolor_style_pony.safetensors` (218 MB), gatilho `wtrcolor`\n- **Workspace criado e ativo:** *Pony · Fantasia* — a LoRA ficou como opcional, então o LLM local só a usa quando você pedir aquarela.\n- **Teste:** gerou em 7,9 s sem erros.\n\nPode usar o chat de geração à direita.' }] },
    ],
  }),
);

// ---- launch
const app = await electron.launch({
  executablePath: require('electron'),
  args: [join(APP, 'out/main/index.js'), `--user-data-dir=${userData}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
  env: { ...process.env, ANTHROPIC_API_KEY: '' },
});
const win = await app.firstWindow();
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
await win.waitForSelector('text=ComfyUI 0.9.2 conectado', { timeout: 15000 });

const gen = win.locator('.pane').nth(1);
await gen.locator('textarea').fill('uma guerreira élfica no penhasco ao pôr do sol, estilo aquarela');
await gen.locator('textarea').press('Enter');
await gen.locator('.gallery img').first().waitFor({ timeout: 20000 });
// Force the film grain LoRA for the next request (auto → sempre).
await gen.locator('.lora-chip.optional', { hasText: 'film_grain_pony' }).click();
await gen.locator('.lora-chip.optional.on', { hasText: 'film_grain_pony' }).waitFor();
await gen.locator('textarea').fill('agora à noite, com lua cheia, 2 variações');
await gen.locator('textarea').press('Enter');
await win.waitForFunction(() => document.querySelectorAll('.pane:nth-of-type(2) .gallery img, .panes > section:last-child .gallery img').length >= 3, null, { timeout: 20000 });
await win.waitForTimeout(800);
// make sure images actually decoded (protocol handler works)
const decoded = await win.evaluate(() => [...document.querySelectorAll('.gallery img')].map((i) => i.naturalWidth));
await win.screenshot({ path: join(OUT, 'screenshot.png') });

await win.locator('button', { hasText: 'Configurações' }).click();
await win.locator('.tab', { hasText: 'LLM local' }).click();
await win.locator('button', { hasText: 'Testar / listar' }).click();
await win.waitForSelector('text=Conectado · 2 modelo(s)');
await win.screenshot({ path: join(OUT, 'screenshot-settings.png') });

const lorasOf = (p) => Object.values(p).filter((x) => x.class_type === 'LoraLoader').map((x) => x.inputs.lora_name);
const appliedChips = await win.evaluate(() => [...document.querySelectorAll('.result:last-of-type .lora-chip.applied')].map((c) => c.textContent));
const report = {
  firstLoras: lorasOf(received[0]),
  secondLoras: lorasOf(received.at(-1)),
  appliedChips,
  decodedWidths: decoded,
  llmCalls: llmRequests.length,
  lastLlmMessages: llmRequests.at(-1).messages.map((m) => m.role),
  comfyPrompts: received.length,
  positive: Object.values(received.at(-1)).filter((x) => x.class_type === 'CLIPTextEncode')[0].inputs.text,
  latent: Object.values(received.at(-1)).find((x) => x.class_type === 'EmptyLatentImage').inputs,
  errors,
};
console.log(JSON.stringify(report, null, 1));
const ok =
  errors.length === 0 &&
  decoded.every((w) => w > 0) &&
  llmRequests.length === 2 &&
  received.length === 2 &&
  report.secondLoras.includes('film_grain_pony.safetensors') &&
  !report.firstLoras.includes('film_grain_pony.safetensors');
await app.close();
comfy.close();
ollama.close();
process.exit(ok ? 0 : 1);
