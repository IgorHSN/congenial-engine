import type { LoraRef, Workspace } from '@shared/types';
import type { ComfyGraph } from './client';
import { findClipSource, findMainSampler, findModelLoader, freeId, rewire, samplerControls, type ApiGraph, type ApiLink } from './graph';

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
  /**
   * Two-pass "hires fix": generate at width×height (native size), upscale the
   * latent to the target size and refine it with a partial denoise.
   */
  hires?: { width: number; height: number; denoise: number; steps: number };
}

type Link = [string, number];

/** Build a ComfyUI API-format graph for a workspace. */
export function buildWorkflow(ws: Workspace, p: GenParams): ComfyGraph {
  if (ws.pipeline === 'custom') return fillTemplate(injectLoras(ws.customWorkflow ?? {}, p.loras), p);

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
  let samples: Link = [sampler, 0];
  if (p.hires) {
    const upscaled = add('LatentUpscale', {
      samples,
      upscale_method: 'nearest-exact',
      width: p.hires.width,
      height: p.hires.height,
      crop: 'disabled',
    });
    const second = add(
      'KSampler',
      {
        model,
        positive,
        negative,
        latent_image: [upscaled, 0],
        seed: p.seed,
        steps: p.hires.steps,
        cfg: isFlux ? 1 : p.cfg,
        sampler_name: p.sampler,
        scheduler: p.scheduler,
        denoise: p.hires.denoise,
      },
      'Hires pass',
    );
    samples = [second, 0];
  }
  const decoded = add('VAEDecode', { samples, vae });
  add('SaveImage', { images: [decoded, 0], filename_prefix: p.filenamePrefix ?? 'atelier' });
  return g;
}

function dedupeLoras(loras: LoraRef[]): LoraRef[] {
  const map = new Map<string, LoraRef>();
  for (const l of loras) if (l.file && l.strength !== 0) map.set(l.file, l);
  return [...map.values()];
}

/**
 * Apply the app's LoRAs to a custom workflow: a LoraLoader chain right after
 * the loader of the main sampler's model (and the CLIP of its positive prompt),
 * with everything that read the loader now reading the end of the chain.
 * Without a CLIP to patch (none found), LoraLoaderModelOnly is used.
 */
export function injectLoras(template: Record<string, unknown>, loras: LoraRef[]): Record<string, unknown> {
  const list = dedupeLoras(loras);
  if (!list.length) return template;
  const g = structuredClone(template) as ApiGraph;
  const main = findMainSampler(g);
  const controls = main ? samplerControls(g, main) : [];
  const loader = findModelLoader(g, controls);
  if (!loader) {
    throw new Error(
      'Não achei o carregador do modelo (checkpoint ou UNET) do sampler principal neste workflow, então as LoRAs não podem ser aplicadas. Desligue as LoRAs deste workspace ou ajuste o workflow.',
    );
  }
  const modelSrc: ApiLink = [loader, 0];
  const clipSrc = findClipSource(g, controls);
  const added = new Set<string>();
  let model: ApiLink = modelSrc;
  let clip: ApiLink | null = clipSrc;
  for (const l of list) {
    const id = freeId(g, 1000);
    g[id] = clip
      ? {
          class_type: 'LoraLoader',
          inputs: { model, clip, lora_name: l.file, strength_model: l.strength, strength_clip: l.strength },
          _meta: { title: 'LoRA (Comfy Atelier)' },
        }
      : { class_type: 'LoraLoaderModelOnly', inputs: { model, lora_name: l.file, strength_model: l.strength }, _meta: { title: 'LoRA (Comfy Atelier)' } };
    added.add(id);
    model = [id, 0];
    if (clip) clip = [id, 1];
  }
  rewire(g, modelSrc, model, added);
  if (clipSrc && clip) rewire(g, clipSrc, clip, added);
  return g;
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
