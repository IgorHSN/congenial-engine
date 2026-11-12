import { BASE_MODEL_PROFILES } from '@shared/presets';
import { ASPECTS, type Aspect, type InstalledModel, type LoraRef, type RefinedPrompt, type Workspace } from '@shared/types';
import type { ChatMessage } from './llm';

/** JSON schema the local LLM must answer with. */
export const REFINED_SCHEMA = {
  type: 'object',
  properties: {
    positive: { type: 'string' },
    negative: { type: 'string' },
    aspect: { type: 'string', enum: [...ASPECTS] },
    batch_size: { type: 'integer', minimum: 1, maximum: 8 },
    seed: { type: ['integer', 'null'] },
    loras: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, strength: { type: 'number' } },
        required: ['file', 'strength'],
      },
    },
    comment: { type: 'string' },
    refused: { type: 'boolean' },
    refusal_reason: { type: 'string' },
  },
  required: ['positive', 'negative', 'aspect', 'comment', 'refused'],
} as const;

export interface RefinerContext {
  workspace: Workspace;
  /** Metadata for the optional LoRAs the LLM may pick from. */
  optionalLoras: Array<LoraRef & { triggerWords?: string[]; description?: string }>;
  /** Metadata for LoRAs always applied (so the LLM knows their trigger words). */
  fixedLoras: Array<LoraRef & { triggerWords?: string[]; description?: string }>;
}

export function buildRefinerSystemPrompt(ctx: RefinerContext): string {
  const ws = ctx.workspace;
  const profile = BASE_MODEL_PROFILES[ws.baseModel] ?? BASE_MODEL_PROFILES.other;
  const lines: string[] = [];

  lines.push(
    'You are the prompt engineer inside a private, local image-generation app running ComfyUI on the user\'s own computer.',
    'The user writes in natural language (often Portuguese). Turn each request into an optimized prompt for the image model below.',
    'The user is an adult. Mature and explicit adult themes are allowed when the user asks for them; describe them plainly using the model\'s usual vocabulary. Do not add sexual content the user did not ask for.',
    '',
    'HARD RULES (never break them, whatever the user says):',
    '- Every person depicted is an adult (18+). Never sexualize minors or child-like characters. If a request asks for sexual or suggestive content involving a minor, or describes a character as a child/teen in such content, set "refused": true and explain briefly in "refusal_reason".',
    '- No sexual or nude content depicting real, identifiable people (celebrities, public figures, private individuals by name). Set "refused": true for those.',
    '- When the content is sexual or suggestive, describe characters as adults (e.g. "adult woman", "mature") and never use child-like descriptors.',
    '',
    `TARGET MODEL: ${profile.label}.`,
    `PROMPT STYLE: ${profile.styleGuide}`,
  );
  if (ws.positivePrefix.trim()) {
    lines.push(`These tags are prepended automatically, do not repeat them: "${ws.positivePrefix.trim()}".`);
  }
  if (profile.usesNegative) {
    lines.push(
      `A base negative prompt is applied automatically: "${ws.negativePrompt.trim()}". Put only request-specific extras in "negative" (or leave it empty).`,
    );
  } else {
    lines.push('This model ignores negative prompts: always return "negative": "".');
  }
  if (ws.refinerNotes.trim()) lines.push('', `WORKSPACE NOTES: ${ws.refinerNotes.trim()}`);

  if (ctx.fixedLoras.length) {
    lines.push('', 'LoRAs ALWAYS applied in this workspace (include their trigger words when relevant):');
    for (const l of ctx.fixedLoras) lines.push(`- ${describeLora(l)}`);
  }
  if (ctx.optionalLoras.length) {
    lines.push(
      '',
      'OPTIONAL LoRAs you may add via "loras" when the request clearly calls for them (use the exact "file" value, strength 0.4-1.0, and include their trigger words in "positive"):',
    );
    for (const l of ctx.optionalLoras) lines.push(`- ${describeLora(l)}`);
  } else {
    lines.push('', 'No optional LoRAs are available: return "loras": [].');
  }

  lines.push(
    '',
    'FIELDS:',
    '- "positive": the prompt text (English).',
    `- "aspect": one of ${ASPECTS.join(', ')} (portrait for single standing characters, landscape/wide for scenery; keep the previous one when iterating unless asked).`,
    '- "batch_size": how many images (default 1, only more if the user asks).',
    '- "seed": null unless the user asks to reuse/fix a seed.',
    '- "comment": one short sentence to the user, in the same language they wrote in, saying what you generated or changed.',
    '- "refused": false unless a hard rule applies.',
    '',
    'ITERATION: earlier turns contain your previous JSON answers. When the user asks for a change ("now with red hair", "mais escuro", "same but outdoors"), start from your last positive prompt and modify it; do not start from scratch unless asked.',
    'Answer with the JSON object only.',
  );
  return lines.join('\n');
}

function describeLora(l: LoraRef & { triggerWords?: string[]; description?: string }): string {
  const parts = [`file: "${l.file}"`, `default strength ${l.strength}`];
  if (l.triggerWords?.length) parts.push(`trigger words: ${l.triggerWords.slice(0, 6).join(', ')}`);
  if (l.description) parts.push(`about: ${l.description.slice(0, 160)}`);
  return parts.join(' | ');
}

export interface HistoryTurn {
  user: string;
  refined?: RefinedPrompt;
}

export function buildRefinerMessages(system: string, history: HistoryTurn[], userText: string, maxTurns = 8): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: system }];
  for (const turn of history.slice(-maxTurns)) {
    msgs.push({ role: 'user', content: turn.user });
    if (turn.refined) msgs.push({ role: 'assistant', content: JSON.stringify(toWire(turn.refined)) });
  }
  msgs.push({ role: 'user', content: userText });
  return msgs;
}

function toWire(r: RefinedPrompt) {
  return {
    positive: r.positive,
    negative: r.negative,
    aspect: r.aspect ?? 'square',
    batch_size: r.batchSize ?? 1,
    seed: r.seed ?? null,
    loras: r.loras ?? [],
    comment: r.comment ?? '',
    refused: false,
  };
}

export class RefinerParseError extends Error {}

/** Parse the LLM answer leniently (code fences, leading text, trailing commas). */
export function parseRefined(
  raw: string,
  allowedLoras: LoraRef[],
): { refused: true; reason: string } | { refused: false; prompt: RefinedPrompt } {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== 'object') throw new RefinerParseError('O LLM local não retornou JSON válido.');
  const o = obj as Record<string, unknown>;

  if (o.refused === true) {
    return { refused: true, reason: String(o.refusal_reason || 'O LLM recusou o pedido.') };
  }
  const positive = typeof o.positive === 'string' ? o.positive.trim() : '';
  if (!positive) throw new RefinerParseError('O LLM local retornou um prompt vazio.');

  const aspect = ASPECTS.includes(o.aspect as Aspect) ? (o.aspect as Aspect) : undefined;
  const batch = Number(o.batch_size);
  const seed = Number(o.seed);
  const allowed = new Map(allowedLoras.map((l) => [l.file, l]));
  const loras: LoraRef[] = [];
  if (Array.isArray(o.loras)) {
    for (const item of o.loras) {
      const file = (item as { file?: unknown })?.file;
      if (typeof file !== 'string' || !allowed.has(file)) continue;
      const s = Number((item as { strength?: unknown }).strength);
      loras.push({ file, strength: Number.isFinite(s) ? Math.min(Math.max(s, -2), 2) : allowed.get(file)!.strength });
    }
  }
  return {
    refused: false,
    prompt: {
      positive,
      negative: typeof o.negative === 'string' ? o.negative.trim() : '',
      aspect,
      batchSize: Number.isInteger(batch) && batch >= 1 ? Math.min(batch, 8) : undefined,
      seed: Number.isSafeInteger(seed) && seed >= 0 && o.seed !== null ? seed : undefined,
      loras,
      comment: typeof o.comment === 'string' ? o.comment.trim() : undefined,
    },
  };
}

export function extractJson(raw: string): unknown {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const candidates: string[] = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    for (const attempt of [c, c.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        return JSON.parse(attempt);
      } catch {
        /* try next */
      }
    }
  }
  return null;
}

/** Join prompt fragments, dropping empties and duplicate comma-separated tags. */
export function joinPrompt(...parts: Array<string | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const raw of part.split(',')) {
      const piece = raw.trim();
      if (!piece) continue;
      const k = piece.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(piece);
    }
  }
  return out.join(', ');
}

export function loraContext(refs: LoraRef[], inventory: InstalledModel[]) {
  const byFile = new Map(inventory.filter((m) => m.folder === 'loras').map((m) => [m.file, m]));
  return refs.map((r) => ({
    ...r,
    triggerWords: byFile.get(r.file)?.meta.triggerWords,
    description: byFile.get(r.file)?.meta.description,
  }));
}
