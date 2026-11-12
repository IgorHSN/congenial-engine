import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { safeJoin } from './paths';

/** Where the ComfyUI frontend saves workflows ("Workflow → Save"). */
export function workflowsDir(root: string): string {
  return join(root, 'user', 'default', 'workflows');
}

export async function listWorkflows(root: string): Promise<Array<{ name: string; sizeKB: number; modified: string }>> {
  const base = workflowsDir(root);
  const out: Array<{ name: string; sizeKB: number; modified: string; mtime: number }> = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs, depth + 1);
      else if (e.name.toLowerCase().endsWith('.json')) {
        const st = await fs.stat(abs);
        out.push({
          name: relative(base, abs).split('\\').join('/'),
          sizeKB: Math.round(st.size / 1024),
          modified: st.mtime.toISOString().slice(0, 16).replace('T', ' '),
          mtime: st.mtimeMs,
        });
      }
    }
  };
  await walk(base, 0);
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 200)
    .map(({ mtime: _m, ...rest }) => rest);
}

/** Resolve a workflow reference: a name inside user/default/workflows, or an absolute .json path. */
export function resolveWorkflowPath(root: string, ref: string): string {
  if (!ref.toLowerCase().endsWith('.json')) throw new Error('Informe um arquivo .json.');
  return isAbsolute(ref) ? ref : safeJoin(workflowsDir(root), ref);
}

export async function readWorkflowFile(path: string): Promise<unknown> {
  const st = await fs.stat(path);
  if (st.size > 8 * 1024 * 1024) throw new Error('Arquivo grande demais para um workflow.');
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

const STANDARD = new Set([
  'CheckpointLoaderSimple',
  'CheckpointLoader',
  'LoraLoader',
  'LoraLoaderModelOnly',
  'CLIPSetLastLayer',
  'CLIPTextEncode',
  'EmptyLatentImage',
  'EmptySD3LatentImage',
  'KSampler',
  'VAEDecode',
  'VAELoader',
  'SaveImage',
  'PreviewImage',
  'UNETLoader',
  'DualCLIPLoader',
  'FluxGuidance',
  'Note',
  'MarkdownNote',
  'Reroute',
  'PrimitiveNode',
]);

interface UiNode {
  id: number | string;
  type: string;
  title?: string;
  mode?: number;
  widgets_values?: unknown[] | Record<string, unknown>;
}

export type WorkflowSummary =
  | {
      format: 'api';
      nodeCount: number;
      classes: Record<string, number>;
      standardPipeline: boolean;
      extracted: Extracted;
      json: string;
      truncated: boolean;
    }
  | {
      format: 'ui';
      nodeCount: number;
      classes: Record<string, number>;
      standardPipeline: boolean;
      nonStandardNodes: string[];
      disabledNodes: string[];
      extracted: Extracted;
      hint: string;
    };

interface Extracted {
  checkpoint?: string;
  unet?: string;
  clips?: string[];
  vae?: string;
  loras: Array<{ file: string; strength: number; strengthClip?: number; enabled: boolean; node: string }>;
  sampler?: { seed?: unknown; steps?: number; cfg?: number; sampler?: string; scheduler?: string; denoise?: number };
  latent?: { width?: number; height?: number; batchSize?: number };
  clipSkip?: number;
  guidance?: number;
  prompts: string[];
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Summarize a ComfyUI workflow (UI or API format) so it can become a workspace. */
export function summarizeWorkflow(data: unknown): WorkflowSummary {
  if (!data || typeof data !== 'object') throw new Error('Workflow inválido.');
  const obj = data as Record<string, unknown>;

  // API format: { "3": { class_type, inputs }, ... }
  const values = Object.values(obj);
  if (!Array.isArray(obj.nodes) && values.length && values.every((v) => v && typeof v === 'object' && 'class_type' in (v as object))) {
    const nodes = values as Array<{ class_type: string; inputs: Record<string, unknown> }>;
    const classes = countBy(nodes.map((n) => n.class_type));
    const ex: Extracted = { loras: [], prompts: [] };
    for (const [id, n] of Object.entries(obj) as Array<[string, { class_type: string; inputs: Record<string, unknown> }]>) {
      const i = n.inputs ?? {};
      apply(ex, n.class_type, id, {
        ckpt_name: i.ckpt_name,
        lora_name: i.lora_name,
        strength_model: i.strength_model,
        strength_clip: i.strength_clip,
        unet_name: i.unet_name,
        clip_name1: i.clip_name1,
        clip_name2: i.clip_name2,
        vae_name: i.vae_name,
        seed: i.seed ?? i.noise_seed,
        steps: i.steps,
        cfg: i.cfg,
        sampler_name: i.sampler_name,
        scheduler: i.scheduler,
        denoise: i.denoise,
        width: i.width,
        height: i.height,
        batch_size: i.batch_size,
        stop_at_clip_layer: i.stop_at_clip_layer,
        guidance: i.guidance,
        text: i.text,
      });
    }
    const json = JSON.stringify(obj);
    return {
      format: 'api',
      nodeCount: nodes.length,
      classes,
      standardPipeline: Object.keys(classes).every((c) => STANDARD.has(c)),
      extracted: ex,
      json: json.slice(0, 60_000),
      truncated: json.length > 60_000,
    };
  }

  if (!Array.isArray(obj.nodes)) throw new Error('Formato de workflow não reconhecido.');
  const subgraphNodes = ((obj.definitions as { subgraphs?: Array<{ nodes?: UiNode[] }> } | undefined)?.subgraphs ?? []).flatMap(
    (s) => s.nodes ?? [],
  );
  const nodes = [...(obj.nodes as UiNode[]), ...subgraphNodes];
  const active = nodes.filter((n) => n.mode !== 2 && n.mode !== 4);
  const classes = countBy(active.map((n) => n.type));
  const ex: Extracted = { loras: [], prompts: [] };

  for (const n of nodes) {
    const enabled = n.mode !== 2 && n.mode !== 4;
    const w = n.widgets_values;
    const label = `${n.type}#${n.id}`;
    if (Array.isArray(w)) {
      // Lora stacks (rgthree Power Lora Loader & co.) keep objects like { on, lora, strength }.
      for (const item of w) {
        if (item && typeof item === 'object' && 'lora' in item && typeof (item as { lora: unknown }).lora === 'string') {
          const it = item as { on?: boolean; lora: string; strength?: number; strengthTwo?: number };
          if (it.lora && it.lora !== 'None') {
            ex.loras.push({ file: it.lora, strength: it.strength ?? 1, strengthClip: it.strengthTwo, enabled: enabled && it.on !== false, node: label });
          }
        }
      }
      if (!enabled) continue;
      const v = w as unknown[];
      switch (n.type) {
        case 'CheckpointLoaderSimple':
          apply(ex, n.type, label, { ckpt_name: v[0] });
          break;
        case 'CheckpointLoader':
          apply(ex, 'CheckpointLoaderSimple', label, { ckpt_name: v[1] });
          break;
        case 'LoraLoader':
          apply(ex, n.type, label, { lora_name: v[0], strength_model: v[1], strength_clip: v[2] });
          break;
        case 'LoraLoaderModelOnly':
          apply(ex, n.type, label, { lora_name: v[0], strength_model: v[1] });
          break;
        case 'KSampler':
          apply(ex, n.type, label, { seed: v[0], steps: v[2], cfg: v[3], sampler_name: v[4], scheduler: v[5], denoise: v[6] });
          break;
        case 'KSamplerAdvanced':
          apply(ex, 'KSampler', label, { seed: v[1], steps: v[3], cfg: v[4], sampler_name: v[5], scheduler: v[6] });
          break;
        case 'EmptyLatentImage':
        case 'EmptySD3LatentImage':
          apply(ex, n.type, label, { width: v[0], height: v[1], batch_size: v[2] });
          break;
        case 'CLIPSetLastLayer':
          apply(ex, n.type, label, { stop_at_clip_layer: v[0] });
          break;
        case 'CLIPTextEncode':
          apply(ex, n.type, label, { text: v[0] });
          break;
        case 'UNETLoader':
          apply(ex, n.type, label, { unet_name: v[0] });
          break;
        case 'DualCLIPLoader':
          apply(ex, n.type, label, { clip_name1: v[0], clip_name2: v[1] });
          break;
        case 'VAELoader':
          apply(ex, n.type, label, { vae_name: v[0] });
          break;
        case 'FluxGuidance':
          apply(ex, n.type, label, { guidance: v[0] });
          break;
        default:
          // Unknown LoRA loaders: grab "*.safetensors" + the next number.
          if (/lora/i.test(n.type)) {
            const idx = v.findIndex((x) => typeof x === 'string' && /\.(safetensors|pt|ckpt)$/i.test(x));
            if (idx !== -1) ex.loras.push({ file: v[idx] as string, strength: num(v[idx + 1]) ?? 1, enabled, node: label });
          }
      }
    }
  }

  const nonStandard = Object.keys(classes).filter((c) => !STANDARD.has(c));
  return {
    format: 'ui',
    nodeCount: nodes.length,
    classes,
    standardPipeline: nonStandard.length === 0,
    nonStandardNodes: nonStandard,
    disabledNodes: nodes.filter((n) => n.mode === 2 || n.mode === 4).map((n) => `${n.type}#${n.id}`),
    extracted: ex,
    hint:
      nonStandard.length === 0
        ? 'Standard pipeline: recreate it with save_workspace (pipeline checkpoint or flux) using the extracted values.'
        : 'Uses non-standard nodes. A faithful copy needs the API format: ask the user to open it in ComfyUI and use Workflow → Export (API), then read that file and save it as a custom workspace with {{placeholders}}. Or approximate it with a standard workspace.',
  };
}

function apply(ex: Extracted, type: string, node: string, f: Record<string, unknown>): void {
  switch (type) {
    case 'CheckpointLoaderSimple':
    case 'CheckpointLoader':
      ex.checkpoint ??= str(f.ckpt_name);
      break;
    case 'LoraLoader':
    case 'LoraLoaderModelOnly':
      if (str(f.lora_name)) {
        ex.loras.push({
          file: str(f.lora_name)!,
          strength: num(f.strength_model) ?? 1,
          strengthClip: num(f.strength_clip),
          enabled: true,
          node,
        });
      }
      break;
    case 'KSampler':
    case 'KSamplerAdvanced':
      ex.sampler ??= {
        seed: f.seed,
        steps: num(f.steps),
        cfg: num(f.cfg),
        sampler: str(f.sampler_name),
        scheduler: str(f.scheduler),
        denoise: num(f.denoise),
      };
      break;
    case 'EmptyLatentImage':
    case 'EmptySD3LatentImage':
      ex.latent ??= { width: num(f.width), height: num(f.height), batchSize: num(f.batch_size) };
      break;
    case 'CLIPSetLastLayer':
      if (num(f.stop_at_clip_layer) !== undefined) ex.clipSkip = Math.abs(num(f.stop_at_clip_layer)!);
      break;
    case 'CLIPTextEncode':
      if (str(f.text)?.trim()) ex.prompts.push(str(f.text)!.slice(0, 600));
      break;
    case 'UNETLoader':
      ex.unet ??= str(f.unet_name);
      break;
    case 'DualCLIPLoader':
      ex.clips ??= [str(f.clip_name1), str(f.clip_name2)].filter((x): x is string => !!x);
      break;
    case 'VAELoader':
      ex.vae ??= str(f.vae_name);
      break;
    case 'FluxGuidance':
      ex.guidance ??= num(f.guidance);
      break;
  }
}

function countBy(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) out[i] = (out[i] ?? 0) + 1;
  return out;
}
