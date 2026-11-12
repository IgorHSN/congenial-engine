import type { LoraRef, Workspace } from '@shared/types';
import type { ComfyGraph } from './client';

export interface GenParams {
  positive: string;
  negative: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  seed: number;
  batchSize: number;
  sampler: string;
  scheduler: string;
  guidance: number;
  clipSkip: number;
  loras: LoraRef[];
  filenamePrefix?: string;
}

type Link = [string, number];

/** Build a ComfyUI API-format graph for a workspace. */
export function buildWorkflow(ws: Workspace, p: GenParams): ComfyGraph {
  if (ws.pipeline === 'custom') return fillTemplate(ws.customWorkflow ?? {}, p);

  const g: ComfyGraph = {};
  let nextId = 1;
  const add = (class_type: string, inputs: Record<string, unknown>, title?: string): string => {
    const id = String(nextId++);
    g[id] = { class_type, inputs, ...(title ? { _meta: { title } } : {}) };
    return id;
  };

  let model: Link;
  let clip: Link;
  let vae: Link;
  const isFlux = ws.baseModel === 'flux' || ws.pipeline === 'flux';

  if (ws.pipeline === 'flux') {
    const unet = add('UNETLoader', { unet_name: ws.unet, weight_dtype: 'default' });
    const clips = add('DualCLIPLoader', { clip_name1: ws.clip1, clip_name2: ws.clip2, type: 'flux' });
    const vaeNode = add('VAELoader', { vae_name: ws.vae });
    model = [unet, 0];
    clip = [clips, 0];
    vae = [vaeNode, 0];
  } else {
    const ckpt = add('CheckpointLoaderSimple', { ckpt_name: ws.checkpoint });
    model = [ckpt, 0];
    clip = [ckpt, 1];
    vae = [ckpt, 2];
    if (ws.vae) vae = [add('VAELoader', { vae_name: ws.vae }), 0];
  }

  for (const lora of dedupeLoras(p.loras)) {
    const id = add('LoraLoader', {
      model,
      clip,
      lora_name: lora.file,
      strength_model: lora.strength,
      strength_clip: lora.strength,
    });
    model = [id, 0];
    clip = [id, 1];
  }

  if (!isFlux && p.clipSkip > 1) {
    clip = [add('CLIPSetLastLayer', { clip, stop_at_clip_layer: -Math.round(p.clipSkip) }), 0];
  }

  let positive: Link = [add('CLIPTextEncode', { clip, text: p.positive }, 'Positive'), 0];
  const negative: Link = [add('CLIPTextEncode', { clip, text: isFlux ? '' : p.negative }, 'Negative'), 0];
  if (isFlux) positive = [add('FluxGuidance', { conditioning: positive, guidance: p.guidance }), 0];

  const latent = add(isFlux ? 'EmptySD3LatentImage' : 'EmptyLatentImage', {
    width: p.width,
    height: p.height,
    batch_size: p.batchSize,
  });
  const sampler = add('KSampler', {
    model,
    positive,
    negative,
    latent_image: [latent, 0],
    seed: p.seed,
    steps: p.steps,
    cfg: isFlux ? 1 : p.cfg,
    sampler_name: p.sampler,
    scheduler: p.scheduler,
    denoise: 1,
  });
  const decoded = add('VAEDecode', { samples: [sampler, 0], vae });
  add('SaveImage', { images: [decoded, 0], filename_prefix: p.filenamePrefix ?? 'atelier' });
  return g;
}

function dedupeLoras(loras: LoraRef[]): LoraRef[] {
  const map = new Map<string, LoraRef>();
  for (const l of loras) if (l.file && l.strength !== 0) map.set(l.file, l);
  return [...map.values()];
}

const NUMERIC = new Set(['seed', 'width', 'height', 'steps', 'cfg', 'batch_size', 'guidance']);

/**
 * Replace {{placeholders}} in a custom API-format workflow. A string that is
 * exactly "{{seed}}" (or another numeric field) becomes a number.
 */
export function fillTemplate(template: Record<string, unknown>, p: GenParams): ComfyGraph {
  const values: Record<string, string | number> = {
    positive: p.positive,
    negative: p.negative,
    seed: p.seed,
    width: p.width,
    height: p.height,
    steps: p.steps,
    cfg: p.cfg,
    batch_size: p.batchSize,
    sampler: p.sampler,
    scheduler: p.scheduler,
    guidance: p.guidance,
  };
  const visit = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const whole = v.match(/^\{\{(\w+)\}\}$/);
      if (whole && whole[1] in values) {
        const val = values[whole[1]];
        return NUMERIC.has(whole[1]) ? Number(val) : val;
      }
      return v.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, visit(x)]));
    }
    return v;
  };
  const graph = visit(structuredClone(template)) as ComfyGraph;
  for (const [id, node] of Object.entries(graph)) {
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string' || typeof node.inputs !== 'object') {
      throw new Error(`Workflow customizado inválido no nó ${id}: use o formato API do ComfyUI ("Save (API)").`);
    }
  }
  return graph;
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 48);
}
