// Helpers to walk an API-format ComfyUI workflow ({ id: { class_type, inputs } }).

export interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
export type ApiGraph = Record<string, ApiNode>;
export type ApiLink = [string, number];

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
export const followConditioning = (key: string) => !NOT_CONDITIONING.has(key);
export const TEXT_KEYS = ['text', 'prompt', 'text_g', 'text_l'];

/** The node id a link input points to, or null when the value is not a link to a node of this graph. */
export function linkOf(g: ApiGraph, v: unknown): string | null {
  return Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number' && String(v[0]) in g
    ? String(v[0])
    : null;
}

/** Breadth-first search upstream from a link input; returns the first node that matches. */
export function findUp(
  g: ApiGraph,
  from: unknown,
  match: (id: string) => boolean,
  follow: (key: string) => boolean = () => true,
  depth = 8,
): string | null {
  const start = linkOf(g, from);
  if (!start) return null;
  const seen = new Set([start]);
  let level = [start];
  for (let d = 0; d < depth && level.length; d++) {
    const next: string[] = [];
    for (const id of level) {
      if (match(id)) return id;
      for (const [k, v] of Object.entries(g[id].inputs)) {
        const up = follow(k) ? linkOf(g, v) : null;
        if (up && !seen.has(up)) {
          seen.add(up);
          next.push(up);
        }
      }
    }
    level = next;
  }
  return null;
}

export const isEmptyLatent = (g: ApiGraph, id: string) => /empty.*latent|latent.*empty/i.test(g[id].class_type);

/** The sampler that starts from an empty latent (so a hires/refiner pass is not mistaken for it). */
export function findMainSampler(g: ApiGraph): string | undefined {
  const samplers = Object.keys(g).filter((id) => linkOf(g, g[id].inputs.latent_image));
  return (
    samplers.find((id) => {
      const up = linkOf(g, g[id].inputs.latent_image);
      return !!up && isEmptyLatent(g, up);
    }) ??
    samplers.find((id) => findUp(g, g[id].inputs.latent_image, (n) => isEmptyLatent(g, n))) ??
    samplers[0]
  );
}

/** The sampler plus the nodes plugged straight into it (guider, sampler, sigmas, noise of SamplerCustomAdvanced). */
export function samplerControls(g: ApiGraph, main: string): string[] {
  const helpers = ['guider', 'sampler', 'sigmas', 'noise'].map((k) => linkOf(g, g[main].inputs[k]));
  return [main, ...helpers.filter((id): id is string => !!id)];
}

/** Where a role's conditioning enters the sampler (BasicGuider takes a single "conditioning"). */
export function conditioningInput(g: ApiGraph, controls: string[], role: 'positive' | 'negative'): unknown {
  return controls
    .map((c) => g[c].inputs[role] ?? (role === 'positive' ? g[c].inputs.conditioning : undefined))
    .find((v) => linkOf(g, v));
}

export const hasTextInput = (g: ApiGraph, id: string) => TEXT_KEYS.some((k) => k in g[id].inputs);

const isModelLoader = (g: ApiGraph, id: string) => typeof g[id].inputs.ckpt_name === 'string' || typeof g[id].inputs.unet_name === 'string';
const isClipLoader = (g: ApiGraph, id: string) =>
  ['clip_name', 'clip_name1', 'ckpt_name'].some((k) => typeof g[id].inputs[k] === 'string');

/** The checkpoint/diffusion-model loader the main sampler uses. */
export function findModelLoader(g: ApiGraph, controls: string[]): string | null {
  const from = controls.map((c) => g[c].inputs.model).find((v) => linkOf(g, v));
  return findUp(g, from, (id) => isModelLoader(g, id), () => true, 12);
}

/** The CLIP output the main positive prompt is encoded with: [loader, output]. */
export function findClipSource(g: ApiGraph, controls: string[]): ApiLink | null {
  const encoder = findUp(g, conditioningInput(g, controls, 'positive'), (id) => hasTextInput(g, id) && !!linkOf(g, g[id].inputs.clip), followConditioning);
  if (!encoder) return null;
  const loader = findUp(g, g[encoder].inputs.clip, (id) => isClipLoader(g, id), () => true, 12);
  if (!loader) return null;
  return [loader, typeof g[loader].inputs.ckpt_name === 'string' ? 1 : 0];
}

/** Point every input that reads `from` at `to` instead (nodes in `skip` are left alone). */
export function rewire(g: ApiGraph, from: ApiLink, to: ApiLink, skip: Set<string> = new Set()): void {
  for (const [id, node] of Object.entries(g)) {
    if (skip.has(id)) continue;
    for (const [k, v] of Object.entries(node.inputs)) {
      if (linkOf(g, v) === from[0] && (v as ApiLink)[1] === from[1]) node.inputs[k] = [to[0], to[1]];
    }
  }
}

/** A node id that is free in the graph (numeric, like ComfyUI's own). */
export function freeId(g: ApiGraph, after = 0): string {
  let n = Math.max(after, ...Object.keys(g).map((k) => parseInt(k, 10)).filter(Number.isFinite)) + 1;
  while (String(n) in g) n++;
  return String(n);
}
