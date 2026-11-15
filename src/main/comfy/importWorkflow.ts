import type { SamplerDefaults, WorkflowImport } from '@shared/types';

interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
type ApiGraph = Record<string, ApiNode>;

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
const HELPER_INPUTS = ['guider', 'sampler', 'sigmas', 'noise'];
/** Inputs that never carry conditioning: not followed when looking for the prompt nodes. */
const NOT_CONDITIONING = new Set([
  'clip',
  'model',
  'vae',
  'image',
  'images',
  'pixels',
  'mask',
  'samples',
  'latent',
  'latent_image',
  'control_net',
  'style_model',
  'clip_vision',
  'clip_vision_output',
  'upscale_model',
  'noise',
  'sampler',
  'sigmas',
]);
const TEXT_KEYS = ['text', 'prompt', 'text_g', 'text_l'];

const isNode = (v: unknown): v is ApiNode =>
  !!v && typeof v === 'object' && typeof (v as ApiNode).class_type === 'string' && !!(v as ApiNode).inputs && typeof (v as ApiNode).inputs === 'object';

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
 * empty latent's size and batch. Everything else stays as the user built it.
 */
export function templateFromApiWorkflow(data: unknown, name = 'Workflow importado'): WorkflowImport {
  const g = parseApiWorkflow(data);
  const ids = Object.keys(g);
  const defaults: Partial<SamplerDefaults> = {};
  const out: WorkflowImport = { name, workflow: g, defaults, usesNegative: false, models: { loras: [] }, replaced: [], warnings: [] };

  const label = (id: string) => `${g[id]._meta?.title || g[id].class_type} (#${id})`;
  const linkOf = (v: unknown): string | null =>
    Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number' && String(v[0]) in g
      ? String(v[0])
      : null;
  const fitsType = (ph: Placeholder, v: unknown) => (TEXT_PLACEHOLDERS.has(ph) ? typeof v === 'string' : typeof v === 'number');

  /** Breadth-first search upstream from a link; returns the first node that matches. */
  const findUp = (from: unknown, match: (id: string) => boolean, follow: (key: string) => boolean = () => true, depth = 8): string | null => {
    const start = linkOf(from);
    if (!start) return null;
    const seen = new Set([start]);
    let level = [start];
    for (let d = 0; d < depth && level.length; d++) {
      const next: string[] = [];
      for (const id of level) {
        if (match(id)) return id;
        for (const [k, v] of Object.entries(g[id].inputs)) {
          const up = follow(k) ? linkOf(v) : null;
          if (up && !seen.has(up)) {
            seen.add(up);
            next.push(up);
          }
        }
      }
      level = next;
    }
    return null;
  };

  /**
   * Put {{ph}} on an input and return the value it replaced. A value wired from a
   * primitive node is replaced in that node, so everything else reading it (e.g.
   * metadata savers) stays in sync; any other wire is cut.
   */
  const place = (id: string, key: string, ph: Placeholder): string | number | undefined => {
    const token = `{{${ph}}}`;
    const value = g[id].inputs[key];
    const src = linkOf(value);
    if (!src) {
      if (!fitsType(ph, value)) return undefined;
      g[id].inputs[key] = token;
      out.replaced.push(`${WHAT[ph]}: ${label(id)}`);
      return value as string | number;
    }
    const prim = Object.entries(g[src].inputs);
    if (prim.length === 1 && !linkOf(prim[0][1]) && fitsType(ph, prim[0][1])) {
      g[src].inputs[prim[0][0]] = token;
      out.replaced.push(`${WHAT[ph]}: ${label(src)}`);
      return prim[0][1] as string | number;
    }
    g[id].inputs[key] = token;
    out.replaced.push(`${WHAT[ph]}: ${label(id)}`);
    out.warnings.push(`O ${WHAT[ph]} vinha do nó ${label(src)}; agora quem define é o app.`);
    return undefined;
  };

  const isEmptyLatent = (id: string) => /empty.*latent|latent.*empty/i.test(g[id].class_type);
  const samplers = ids.filter((id) => linkOf(g[id].inputs.latent_image));
  const main =
    samplers.find((id) => {
      const up = linkOf(g[id].inputs.latent_image);
      return !!up && isEmptyLatent(up);
    }) ??
    samplers.find((id) => findUp(g[id].inputs.latent_image, isEmptyLatent)) ??
    samplers[0];

  if (!main) {
    out.warnings.push('Não achei o sampler principal (um nó com latent_image); nada foi trocado por valores do app.');
  } else {
    const control = [main, ...HELPER_INPUTS.map((k) => linkOf(g[main].inputs[k])).filter((id): id is string => !!id)];

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
    const condFrom = (role: 'positive' | 'negative') =>
      control.map((c) => g[c].inputs[role] ?? (role === 'positive' ? g[c].inputs.conditioning : undefined)).find((v) => linkOf(v));
    const follow = (k: string) => !NOT_CONDITIONING.has(k);
    const hasText = (id: string) => TEXT_KEYS.some((k) => k in g[id].inputs);
    const placeText = (id: string, ph: 'positive' | 'negative') => {
      let first: string | undefined;
      for (const k of TEXT_KEYS) {
        if (!(k in g[id].inputs)) continue;
        const original = place(id, k, ph);
        if (typeof original === 'string') first ??= original;
      }
      return first;
    };

    const posEncoder = findUp(condFrom('positive'), hasText, follow);
    if (posEncoder) {
      out.positive = placeText(posEncoder, 'positive');
    } else {
      out.warnings.push('Não achei o nó do prompt positivo (ex.: CLIPTextEncode); o texto do app não vai entrar no workflow.');
    }
    // Flux-style guidance on the positive side.
    const guidanceNode = findUp(condFrom('positive'), (id) => typeof g[id].inputs.guidance === 'number', follow);
    if (guidanceNode) {
      const original = place(guidanceNode, 'guidance', 'guidance');
      if (typeof original === 'number') defaults.guidance = original;
    }

    const negFrom = condFrom('negative');
    if (negFrom) {
      const zeroed = findUp(negFrom, (id) => /zero/i.test(g[id].class_type), follow);
      const negEncoder = zeroed ? null : findUp(negFrom, hasText, follow);
      if (negEncoder && negEncoder !== posEncoder) {
        out.negative = placeText(negEncoder, 'negative');
        out.usesNegative = true;
      } else if (!zeroed) {
        out.warnings.push('Não achei o nó do prompt negativo; o negativo do app não vai entrar no workflow.');
      }
    }

    // Size and batch on the empty latent.
    const latent = findUp(g[main].inputs.latent_image, isEmptyLatent);
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

    // The model the main sampler uses.
    const modelFrom = control.map((c) => g[c].inputs.model).find((v) => linkOf(v));
    const loader = findUp(modelFrom, (id) => typeof g[id].inputs.ckpt_name === 'string' || typeof g[id].inputs.unet_name === 'string', () => true, 12);
    if (loader) {
      const i = g[loader].inputs;
      if (typeof i.ckpt_name === 'string') out.models.checkpoint = i.ckpt_name;
      else out.models.unet = i.unet_name as string;
    }
  }

  // LoRAs: core loaders and rgthree's Power Lora Loader (lora_1: { on, lora, strength }).
  for (const id of ids) {
    for (const [k, v] of Object.entries(g[id].inputs)) {
      const file =
        k === 'lora_name' && typeof v === 'string'
          ? v
          : /^lora_\d+$/.test(k) && v && typeof v === 'object' && (v as { on?: unknown }).on !== false
            ? (v as { lora?: unknown }).lora
            : undefined;
      if (typeof file === 'string' && file !== 'None' && !out.models.loras.includes(file)) out.models.loras.push(file);
    }
  }

  // The app only receives images saved to the output folder.
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
