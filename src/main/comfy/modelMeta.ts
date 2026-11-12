import { promises as fs } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { BaseModel, ModelFolder, ModelMeta } from '@shared/types';
import { civitaiBaseModel } from '../sources/civitai';

const MAX_HEADER = 64 * 1024 * 1024;

export interface SafetensorsHeader {
  metadata: Record<string, string>;
  keys: string[];
}

/** Read the JSON header of a .safetensors file (8-byte little-endian length + JSON). */
export async function readSafetensorsHeader(path: string): Promise<SafetensorsHeader | null> {
  let fh: import('node:fs/promises').FileHandle | null = null;
  try {
    fh = await fs.open(path, 'r');
    const lenBuf = Buffer.alloc(8);
    const { bytesRead } = await fh.read(lenBuf, 0, 8, 0);
    if (bytesRead < 8) return null;
    const len = Number(lenBuf.readBigUInt64LE(0));
    if (!Number.isFinite(len) || len <= 2 || len > MAX_HEADER) return null;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 8);
    const header = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
    const metadata = (header.__metadata__ ?? {}) as Record<string, string>;
    delete header.__metadata__;
    return { metadata, keys: Object.keys(header) };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Refine an SDXL-architecture guess with name hints (Pony/Illustrious/NoobAI share the SDXL architecture). */
function refineXl(...hints: Array<string | undefined>): BaseModel {
  const text = hints.filter(Boolean).join(' ').toLowerCase();
  if (/pony|pdxl|score_9/.test(text)) return 'pony';
  if (/noob/.test(text)) return 'noobai';
  if (/illustrious|illu|\bilxl\b|\bil_?xl\b|wai[-_ ]?nsfw|waiillu/.test(text)) return 'illustrious';
  return 'sdxl';
}

export function baseModelFromName(name: string): BaseModel | undefined {
  const n = name.toLowerCase();
  if (/flux/.test(n)) return 'flux';
  if (/sd3\.?5|sd35/.test(n)) return 'sd35';
  if (/pony|pdxl/.test(n)) return 'pony';
  if (/noob/.test(n)) return 'noobai';
  if (/illustrious|\bilxl\b|illu/.test(n)) return 'illustrious';
  if (/sdxl|[-_ ]xl\b|xl[-_ ]/.test(n)) return 'sdxl';
  if (/sd[-_ ]?1\.?5|\bsd15\b|v1-5/.test(n)) return 'sd15';
  return undefined;
}

/** Guess base model / triggers from safetensors metadata and tensor names. */
export function metaFromSafetensors(h: SafetensorsHeader, folder: ModelFolder, fileName: string): ModelMeta {
  const m = h.metadata;
  const out: ModelMeta = {};
  const arch = (m['modelspec.architecture'] ?? '').toLowerCase();
  const ssBase = (m.ss_base_model_version ?? '').toLowerCase();
  const nameHints = [fileName, m.ss_sd_model_name, m.ss_output_name, m['modelspec.title'], m['modelspec.description']];

  let base: BaseModel | undefined;
  if (arch.includes('flux') || ssBase.includes('flux')) base = 'flux';
  else if (arch.includes('stable-diffusion-v3') || ssBase.startsWith('sd3')) base = 'sd35';
  else if (arch.includes('xl') || ssBase.includes('sdxl')) base = refineXl(...nameHints);
  else if (arch.includes('stable-diffusion-v1') || ssBase.startsWith('sd_v1') || ssBase === 'sd_v1') base = 'sd15';

  if (!base) {
    const keys = h.keys;
    const has = (re: RegExp) => keys.some((k) => re.test(k));
    if (has(/double_blocks|single_blocks|single_transformer_blocks|transformer_blocks\.\d+\.attn\.add_q_proj/)) base = 'flux';
    else if (has(/joint_blocks/)) base = 'sd35';
    else if (has(/^conditioner\.embedders\.1|lora_te2_|^te2[._]|text_encoder_2/)) base = refineXl(...nameHints);
    else if (has(/^cond_stage_model\.transformer|^model\.diffusion_model\.input_blocks/) || (folder === 'loras' && has(/^lora_unet_|^lora_te_/))) {
      base = has(/^conditioner\./) ? refineXl(...nameHints) : folder === 'loras' && has(/lora_te1_/) ? refineXl(...nameHints) : 'sd15';
    }
  }
  if (base) {
    out.baseModel = base;
    out.detectedFrom = 'safetensors';
  }

  const trigger = m['modelspec.trigger_phrase'];
  if (trigger) out.triggerWords = trigger.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);

  if (m.ss_tag_frequency) {
    try {
      const freq = JSON.parse(m.ss_tag_frequency) as Record<string, Record<string, number>>;
      const totals = new Map<string, number>();
      for (const dataset of Object.values(freq)) {
        for (const [tag, n] of Object.entries(dataset)) totals.set(tag.trim(), (totals.get(tag.trim()) ?? 0) + n);
      }
      out.trainingTags = [...totals.entries()]
        .filter(([t]) => t)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([t]) => t);
    } catch {
      /* malformed */
    }
  }
  if (m['modelspec.description'] && !out.description) out.description = String(m['modelspec.description']).slice(0, 200);
  return out;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Metadata written next to the model by other tools:
 * - <name>.civitai.info  (sd-civitai-browser / Civitai Helper)
 * - <name>.metadata.json (ComfyUI-Lora-Manager)
 * - <name>.json          (AUTOMATIC1111 / Forge user metadata)
 */
export async function metaFromSidecars(modelPath: string): Promise<ModelMeta> {
  const dir = dirname(modelPath);
  const stem = basename(modelPath, extname(modelPath));

  const info = await readJson(join(dir, `${stem}.civitai.info`));
  if (info && (info.trainedWords || info.baseModel)) {
    const model = (info.model ?? {}) as { name?: string; nsfw?: boolean };
    return {
      baseModel: civitaiBaseModel(info.baseModel as string | undefined),
      triggerWords: nonEmpty(info.trainedWords as string[] | undefined),
      nsfw: model.nsfw,
      description: model.name ? `${model.name}${info.name ? ` — ${String(info.name)}` : ''}` : undefined,
      source:
        info.modelId && info.id
          ? {
              kind: 'civitai',
              url: `https://civitai.com/models/${String(info.modelId)}?modelVersionId=${String(info.id)}`,
              civitaiModelId: Number(info.modelId),
              civitaiVersionId: Number(info.id),
            }
          : undefined,
      detectedFrom: 'civitai-info',
    };
  }

  const lm = await readJson(join(dir, `${stem}.metadata.json`));
  if (lm && (lm.base_model || lm.civitai)) {
    const civ = (lm.civitai ?? {}) as { trainedWords?: string[]; modelId?: number; id?: number; baseModel?: string };
    let strength: number | undefined;
    try {
      strength = Number(JSON.parse(String(lm.usage_tips ?? '{}')).strength) || undefined;
    } catch {
      strength = undefined;
    }
    return {
      baseModel: civitaiBaseModel((lm.base_model as string | undefined) ?? civ.baseModel),
      triggerWords: nonEmpty(civ.trainedWords),
      recommendedStrength: strength,
      description: typeof lm.model_name === 'string' ? lm.model_name : undefined,
      source:
        civ.modelId && civ.id
          ? {
              kind: 'civitai',
              url: `https://civitai.com/models/${civ.modelId}?modelVersionId=${civ.id}`,
              civitaiModelId: civ.modelId,
              civitaiVersionId: civ.id,
            }
          : undefined,
      detectedFrom: 'lora-manager',
    };
  }

  const a1111 = await readJson(join(dir, `${stem}.json`));
  if (a1111 && ('activation text' in a1111 || 'sd version' in a1111 || 'preferred weight' in a1111)) {
    const version = String(a1111['sd version'] ?? '').toLowerCase();
    const weight = Number(a1111['preferred weight']);
    return {
      baseModel: version.includes('xl') ? refineXl(stem) : version.includes('1') ? 'sd15' : undefined,
      triggerWords: nonEmpty(
        String(a1111['activation text'] ?? '')
          .split(',')
          .map((s) => s.trim()),
      ),
      recommendedStrength: Number.isFinite(weight) && weight > 0 ? weight : undefined,
      description: typeof a1111.description === 'string' && a1111.description ? a1111.description.slice(0, 200) : undefined,
      detectedFrom: 'a1111',
    };
  }
  return {};
}

function nonEmpty(list: string[] | undefined): string[] | undefined {
  const clean = (list ?? []).map((s) => String(s).trim()).filter(Boolean);
  return clean.length ? clean.slice(0, 12) : undefined;
}

/** Combine every offline source: sidecar files win over the header, the header over the file name. */
export async function detectMeta(path: string, folder: ModelFolder, file: string): Promise<ModelMeta> {
  const sidecar = await metaFromSidecars(path);
  const header = path.toLowerCase().endsWith('.safetensors') || path.toLowerCase().endsWith('.sft') ? await readSafetensorsHeader(path) : null;
  const fromHeader = header ? metaFromSafetensors(header, folder, file) : {};
  const fromName: ModelMeta = {};
  const guess = baseModelFromName(file);
  if (guess) {
    fromName.baseModel = guess;
    fromName.detectedFrom = 'filename';
  }
  const merged: ModelMeta = { ...fromName, ...strip(fromHeader), ...strip(sidecar) };
  // A name hint like "pony" beats a bare "sdxl" from the header.
  if (merged.baseModel === 'sdxl' && guess && ['pony', 'illustrious', 'noobai'].includes(guess)) merged.baseModel = guess;
  if (!merged.baseModel) delete merged.detectedFrom;
  return merged;
}

function strip(meta: ModelMeta): ModelMeta {
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined)) as ModelMeta;
}
