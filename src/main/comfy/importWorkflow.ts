import type { ImportedLora, SamplerDefaults, WorkflowImport } from '@shared/types';
import {
  conditioningInput,
  findMainSampler,
  findModelLoader,
  findUp,
  followConditioning,
  hasTextInput,
  isEmptyLatent,
  linkOf,
  rewire,
  samplerControls,
  TEXT_KEYS,
  type ApiGraph,
  type ApiLink,
  type ApiNode,
} from './graph';

type Placeholder = 'positive' | 'negative' | 'seed' | 'width' | 'height' | 'steps' | 'cfg' | 'batch_size' | 'sampler' | 'scheduler' | 'guidance';

const WHAT: Record<Placeholder, string> = {
  positive: 'prompt positivo',
  negative: 'prompt negativo',
  seed: 'seed',
  width: 'largura',
  height: 'altura',
  steps: 'steps',
  cfg: 'CFG',
  batch_size: 'número de imagens',
  sampler: 'sampler',
  scheduler: 'scheduler',
  guidance: 'guidance',
};
const TEXT_PLACEHOLDERS = new Set<Placeholder>(['positive', 'negative', 'sampler', 'scheduler']);

/** Sampler settings, searched on the main sampler and the nodes plugged straight into it (guider, sigmas, noise...). */
const SAMPLER_KEYS: Array<[string, Placeholder]> = [
  ['seed', 'seed'],
  ['noise_seed', 'seed'],
  ['steps', 'steps'],
  ['cfg', 'cfg'],
  ['sampler_name', 'sampler'],
  ['scheduler', 'scheduler'],
];

const isNode = (v: unknown): v is ApiNode =>
  !!v && typeof v === 'object' && typeof (v as ApiNode).class_type === 'string' && !!(v as ApiNode).inputs && typeof (v as ApiNode).inputs === 'object';

const toNumber = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Check that a file is an API-format workflow ("Export (API)") and return a copy of it. */
export function parseApiWorkflow(data: unknown): ApiGraph {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Arquivo de workflow inválido.');
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.nodes)) {
    throw new Error(
      'Este arquivo está no formato normal do ComfyUI. No ComfyUI, abra o workflow e use Workflow → Export (API); depois importe o arquivo exportado.',
    );
  }
  const nodes = Object.values(obj);
  if (!nodes.length || !nodes.every(isNode)) throw new Error('Formato não reconhecido: use o arquivo gerado por Workflow → Export (API) no ComfyUI.');
  return structuredClone(obj) as ApiGraph;
}

/**
 * Turn an API-format workflow into a custom-workspace template: find the main
 * sampler (the one fed by an empty latent), then put {{placeholders}} on its
 * prompt texts, seed, steps, cfg, sampler, scheduler, guidance and on the
 * empty latent's size and batch. Active LoRAs move out of the workflow into
 * the workspace (the app re-applies them, see injectLoras). Everything else
 * stays as the user built it.
 */
export function templateFromApiWorkflow(data: unknown, name = 'Workflow importado'): WorkflowImport {
  const g = parseApiWorkflow(data);
  const defaults: Partial<SamplerDefaults> = {};
  const out: WorkflowImport = { name, workflow: g, defaults, usesNegative: false, models: {}, loras: [], replaced: [], warnings: [] };

  const label = (id: string) => `${g[id]._meta?.title || g[id].class_type} (#${id})`;
  const fitsType = (ph: Placeholder, v: unknown) => (TEXT_PLACEHOLDERS.has(ph) ? typeof v === 'string' : typeof v === 'number');

  /**
   * Put {{ph}} on an input and return the value it replaced. A value wired from a
   * primitive node is replaced in that node, so everything else reading it (e.g.
   * metadata savers) stays in sync; any other wire is cut.
   */
  const place = (id: string, key: string, ph: Placeholder): string | number | undefined => {
    const token = `{{${ph}}}`;
    const value = g[id].inputs[key];
    const src = linkOf(g, value);
    if (!src) {
      if (!fitsType(ph, value)) return undefined;
      g[id].inputs[key] = token;
      out.replaced.push(`${WHAT[ph]}: ${label(id)}`);
      return value as string | number;
    }
    const prim = Object.entries(g[src].inputs);
    if (prim.length === 1 && !linkOf(g, prim[0][1]) && fitsType(ph, prim[0][1])) {
      g[src].inputs[prim[0][0]] = token;
      out.replaced.push(`${WHAT[ph]}: ${label(src)}`);
      return prim[0][1] as string | number;
    }
    g[id].inputs[key] = token;
    out.replaced.push(`${WHAT[ph]}: ${label(id)}`);
    out.warnings.push(`O ${WHAT[ph]} vinha do nó ${label(src)}; agora quem define é o app.`);
    return undefined;
  };

  // LoRAs first, so the model and CLIP wires below see the graph without them.
  extractLoras(g, out.loras, label);

  const main = findMainSampler(g);
  if (!main) {
    out.warnings.push('Não achei o sampler principal (um nó com latent_image); nada foi trocado por valores do app.');
  } else {
    const control = samplerControls(g, main);

    // Sampler settings.
    const placed = new Set<Placeholder>();
    for (const [key, ph] of SAMPLER_KEYS) {
      if (placed.has(ph)) continue;
      const id = control.find((c) => key in g[c].inputs);
      if (!id) continue;
      placed.add(ph);
      const original = place(id, key, ph);
      if (ph === 'steps' && typeof original === 'number') defaults.steps = original;
      if (ph === 'cfg' && typeof original === 'number') defaults.cfg = original;
      if (ph === 'sampler' && typeof original === 'string') defaults.sampler = original;
      if (ph === 'scheduler' && typeof original === 'string') defaults.scheduler = original;
    }
    if (!placed.has('seed')) out.warnings.push('Não achei a seed do sampler principal; toda geração vai usar a seed fixa do workflow.');
    if (!placed.has('steps')) out.warnings.push('Não achei os steps do sampler principal; o valor do app não terá efeito.');

    // Prompts: follow the conditioning wires from the sampler (or its guider) to the text encoders.
    const hasText = (id: string) => hasTextInput(g, id);
    const placeText = (id: string, ph: 'positive' | 'negative') => {
      let first: string | undefined;
      for (const k of TEXT_KEYS) {
        if (!(k in g[id].inputs)) continue;
        const original = place(id, k, ph);
        if (typeof original === 'string') first ??= original;
      }
      return first;
    };

    const posFrom = conditioningInput(g, control, 'positive');
    const posEncoder = findUp(g, posFrom, hasText, followConditioning);
    if (posEncoder) {
      out.positive = placeText(posEncoder, 'positive');
    } else {
      out.warnings.push('Não achei o nó do prompt positivo (ex.: CLIPTextEncode); o texto do app não vai entrar no workflow.');
    }
    // Flux-style guidance on the positive side.
    const guidanceNode = findUp(g, posFrom, (id) => typeof g[id].inputs.guidance === 'number', followConditioning);
    if (guidanceNode) {
      const original = place(guidanceNode, 'guidance', 'guidance');
      if (typeof original === 'number') defaults.guidance = original;
    }

    const negFrom = conditioningInput(g, control, 'negative');
    if (negFrom) {
      const zeroed = findUp(g, negFrom, (id) => /zero/i.test(g[id].class_type), followConditioning);
      const negEncoder = zeroed ? null : findUp(g, negFrom, hasText, followConditioning);
      if (negEncoder && negEncoder !== posEncoder) {
        out.negative = placeText(negEncoder, 'negative');
        out.usesNegative = true;
      } else if (!zeroed) {
        out.warnings.push('Não achei o nó do prompt negativo; o negativo do app não vai entrar no workflow.');
      }
    }

    // Size and batch on the empty latent.
    const latent = findUp(g, g[main].inputs.latent_image, (id) => isEmptyLatent(g, id));
    if (latent) {
      for (const [key, ph] of [
        ['width', 'width'],
        ['height', 'height'],
        ['batch_size', 'batch_size'],
      ] as const) {
        if (!(key in g[latent].inputs)) continue;
        const original = place(latent, key, ph);
        if (typeof original !== 'number') continue;
        if (ph === 'width') defaults.width = original;
        else if (ph === 'height') defaults.height = original;
        else defaults.batchSize = original;
      }
    } else {
      out.warnings.push('Não achei o nó de tamanho (Empty Latent); o tamanho escolhido no app não terá efeito.');
    }

    // The model the main sampler uses (the app puts its LoRAs right after this loader).
    const loader = findModelLoader(g, control);
    if (loader) {
      const i = g[loader].inputs;
      if (typeof i.ckpt_name === 'string') out.models.checkpoint = i.ckpt_name;
      else out.models.unet = i.unet_name as string;
    } else {
      out.warnings.push('Não achei o carregador do modelo do sampler principal; as LoRAs do app não poderão ser aplicadas neste workflow.');
    }
  }

  // The app only receives images saved to the output folder.
  const ids = Object.keys(g);
  const savesImages = ids.some((id) => /save/i.test(g[id].class_type) && ('images' in g[id].inputs || 'image' in g[id].inputs));
  if (!savesImages) {
    const previews = ids.filter((id) => g[id].class_type === 'PreviewImage');
    for (const id of previews) {
      g[id] = { ...g[id], class_type: 'SaveImage', inputs: { ...g[id].inputs, filename_prefix: 'atelier' } };
      out.replaced.push(`PreviewImage virou SaveImage, para o app receber a imagem: ${label(id)}`);
    }
    if (!previews.length) out.warnings.push('O workflow não tem nó que salve imagens (ex.: SaveImage); o app não vai receber o resultado.');
  }

  return out;
}

/**
 * Take the active LoRAs out of the workflow so the workspace can manage them:
 * core LoraLoader / LoraLoaderModelOnly nodes are removed (their wires pass
 * through), rgthree's Power Lora Loader entries are switched off and LoRA
 * Manager's list and text are emptied (those nodes stay, doing nothing).
 */
function extractLoras(g: ApiGraph, loras: ImportedLora[], label: (id: string) => string): void {
  const add = (file: string, strength: unknown, from: string, byName = false) => {
    const s = toNumber(strength) ?? 1;
    if (!file || file === 'None' || s === 0) return;
    const norm = file.replace(/\\/g, '/');
    if (!loras.some((l) => l.file === norm)) loras.push({ file: norm, strength: s, from, ...(byName ? { byName } : {}) });
  };

  for (const id of Object.keys(g)) {
    const node = g[id];
    const i = node.inputs;
    if ((node.class_type === 'LoraLoader' || node.class_type === 'LoraLoaderModelOnly') && typeof i.lora_name === 'string') {
      add(i.lora_name, i.strength_model, label(id));
      if (linkOf(g, i.model)) rewire(g, [id, 0], i.model as ApiLink);
      if (node.class_type === 'LoraLoader' && linkOf(g, i.clip)) rewire(g, [id, 1], i.clip as ApiLink);
      delete g[id];
      continue;
    }
    // rgthree Power Lora Loader: lora_1: { on, lora, strength }
    for (const [k, v] of Object.entries(i)) {
      if (!/^lora_\d+$/.test(k) || !v || typeof v !== 'object' || Array.isArray(v)) continue;
      const entry = v as { on?: unknown; lora?: unknown; strength?: unknown };
      if (entry.on !== false && typeof entry.lora === 'string') add(entry.lora, entry.strength, label(id));
      i[k] = { ...entry, on: false };
    }
    // LoRA Manager: loras: { __value__: [{ name, strength, active }] } plus a "<lora:name:strength>" text.
    const list = (i.loras as { __value__?: unknown } | undefined)?.__value__;
    if (Array.isArray(list)) {
      for (const e of list as Array<{ name?: unknown; strength?: unknown; active?: unknown }>) {
        if (e.active !== false && typeof e.name === 'string') add(e.name, e.strength, label(id), true);
      }
      i.loras = { __value__: [] };
      if (typeof i.text === 'string') {
        // The list already says which are active; read the text only when there is no list.
        if (!list.length) for (const m of i.text.matchAll(/<lora:([^:>]+):([^:>]+)(?::[^>]*)?>/g)) add(m[1].trim(), m[2], label(id), true);
        i.text = '';
      }
    }
  }
}
