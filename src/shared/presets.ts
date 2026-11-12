import type { Aspect, BaseModel, SamplerDefaults, SizeRequest } from './types';

type Size = { width: number; height: number };

const SD15_SIZES: Record<Aspect, Size> = {
  square: { width: 512, height: 512 },
  portrait: { width: 512, height: 768 },
  landscape: { width: 768, height: 512 },
  wide: { width: 912, height: 512 },
  tall: { width: 512, height: 912 },
};

const XL_SIZES: Record<Aspect, Size> = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 832, height: 1216 },
  landscape: { width: 1216, height: 832 },
  wide: { width: 1344, height: 768 },
  tall: { width: 768, height: 1344 },
};

export interface BaseModelProfile {
  label: string;
  /** How prompts should be written for this family. */
  promptStyle: 'tags' | 'danbooru' | 'natural';
  sizes: Record<Aspect, Size>;
  defaults: SamplerDefaults;
  positivePrefix: string;
  negativePrompt: string;
  /** Whether negative prompts have any effect (Flux at cfg 1 ignores them). */
  usesNegative: boolean;
  /** Guidance for the local prompt refiner. */
  styleGuide: string;
}

const XL_DEFAULTS: SamplerDefaults = {
  width: 1024,
  height: 1024,
  steps: 28,
  cfg: 6,
  sampler: 'dpmpp_2m',
  scheduler: 'karras',
  batchSize: 1,
  clipSkip: 1,
  guidance: 3.5,
};

/** Always kept in the negative prompt for model families that use one. */
export const SAFETY_NEGATIVE = 'child, loli, shota, underage';

export const BASE_MODEL_PROFILES: Record<BaseModel, BaseModelProfile> = {
  sd15: {
    label: 'Stable Diffusion 1.5',
    promptStyle: 'tags',
    sizes: SD15_SIZES,
    defaults: { ...XL_DEFAULTS, width: 512, height: 768, steps: 25, cfg: 7 },
    positivePrefix: 'masterpiece, best quality',
    negativePrompt: 'worst quality, low quality, blurry, bad anatomy, bad hands, extra fingers, watermark, text',
    usesNegative: true,
    styleGuide:
      'Write a comma-separated list of short tags and phrases, most important first. ' +
      'Emphasis syntax (term:1.2) is allowed sparingly. Keep it under ~60 tokens.',
  },
  sdxl: {
    label: 'SDXL',
    promptStyle: 'natural',
    sizes: XL_SIZES,
    defaults: XL_DEFAULTS,
    positivePrefix: '',
    negativePrompt: 'worst quality, low quality, blurry, deformed, bad anatomy, bad hands, watermark, text, signature',
    usesNegative: true,
    styleGuide:
      'Write one or two descriptive sentences followed by comma-separated detail tags ' +
      '(subject, clothing, pose, setting, lighting, camera/lens, style).',
  },
  pony: {
    label: 'Pony Diffusion (SDXL)',
    promptStyle: 'danbooru',
    sizes: XL_SIZES,
    defaults: { ...XL_DEFAULTS, cfg: 7, sampler: 'euler_ancestral', scheduler: 'normal', clipSkip: 2 },
    positivePrefix: 'score_9, score_8_up, score_7_up',
    negativePrompt: 'score_4, score_5, score_6, worst quality, low quality, blurry, bad anatomy, watermark, text',
    usesNegative: true,
    styleGuide:
      'Use danbooru-style tags separated by commas. Include one source tag (source_anime, source_realistic, ' +
      'source_cartoon or source_furry) and one rating tag (rating_safe, rating_questionable or rating_explicit) ' +
      'that matches the request. Do NOT write score_* tags: they are added automatically.',
  },
  illustrious: {
    label: 'Illustrious XL',
    promptStyle: 'danbooru',
    sizes: XL_SIZES,
    defaults: { ...XL_DEFAULTS, cfg: 5.5, sampler: 'euler_ancestral', scheduler: 'normal', clipSkip: 2 },
    positivePrefix: 'masterpiece, best quality, very aesthetic, absurdres',
    negativePrompt:
      'worst quality, low quality, lowres, bad anatomy, bad hands, extra digits, fewer digits, jpeg artifacts, watermark, signature, text',
    usesNegative: true,
    styleGuide:
      'Use danbooru tags separated by commas: character count (1girl, 1boy, 2girls...), character/series names, ' +
      'appearance, clothing, pose, expression, background, composition. Add "general", "sensitive", "questionable" ' +
      'or "explicit" as the rating tag that matches the request. Do NOT repeat the quality tags.',
  },
  noobai: {
    label: 'NoobAI XL',
    promptStyle: 'danbooru',
    sizes: XL_SIZES,
    defaults: { ...XL_DEFAULTS, cfg: 5, sampler: 'euler_ancestral', scheduler: 'normal', clipSkip: 2 },
    positivePrefix: 'masterpiece, best quality, newest, absurdres, highres',
    negativePrompt: 'worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands',
    usesNegative: true,
    styleGuide:
      'Use danbooru tags separated by commas (character count, names, appearance, clothing, pose, background). ' +
      'Add the rating tag (general, sensitive, questionable, explicit) that matches the request. Do NOT repeat the quality tags.',
  },
  flux: {
    label: 'Flux',
    promptStyle: 'natural',
    sizes: XL_SIZES,
    defaults: { ...XL_DEFAULTS, steps: 20, cfg: 1, sampler: 'euler', scheduler: 'simple', guidance: 3.5 },
    positivePrefix: '',
    negativePrompt: '',
    usesNegative: false,
    styleGuide:
      'Write a rich natural-language description in full sentences (subject, appearance, action, setting, lighting, ' +
      'camera, mood, style), 40-120 words. No tag lists, no weights. Leave "negative" empty.',
  },
  sd35: {
    label: 'Stable Diffusion 3.5',
    promptStyle: 'natural',
    sizes: XL_SIZES,
    defaults: { ...XL_DEFAULTS, steps: 30, cfg: 4.5, sampler: 'euler', scheduler: 'sgm_uniform' },
    positivePrefix: '',
    negativePrompt: 'blurry, low quality, deformed, watermark, text',
    usesNegative: true,
    styleGuide: 'Write a natural-language description in full sentences, 30-100 words.',
  },
  other: {
    label: 'Other',
    promptStyle: 'natural',
    sizes: XL_SIZES,
    defaults: XL_DEFAULTS,
    positivePrefix: '',
    negativePrompt: 'worst quality, low quality, blurry',
    usesNegative: true,
    styleGuide: 'Write a clear descriptive prompt: a sentence followed by comma-separated details.',
  },
};

export function sizeFor(baseModel: BaseModel, aspect: Aspect): Size {
  return BASE_MODEL_PROFILES[baseModel].sizes[aspect];
}

/** Whether a LoRA trained for `lora` should work on a workspace of family `ws`. */
export function loraCompatible(lora: BaseModel | undefined, ws: BaseModel): 'yes' | 'maybe' | 'no' {
  if (!lora || lora === 'other' || ws === 'other') return 'maybe';
  if (lora === ws) return 'yes';
  const xl = new Set<BaseModel>(['sdxl', 'pony', 'illustrious', 'noobai']);
  if (xl.has(lora) && xl.has(ws)) return 'maybe';
  return 'no';
}

// ---------------------------------------------------------------------------
// Image size

/** Ratios offered by the size picker. */
export const RATIO_PRESETS: Array<{ id: string; label: string; w: number; h: number }> = [
  { id: '1:1', label: 'Quadrado', w: 1, h: 1 },
  { id: '2:3', label: 'Retrato', w: 2, h: 3 },
  { id: '3:2', label: 'Paisagem', w: 3, h: 2 },
  { id: '4:5', label: 'Retrato 4:5', w: 4, h: 5 },
  { id: '9:16', label: 'Story / celular', w: 9, h: 16 },
  { id: '16:9', label: 'Widescreen', w: 16, h: 9 },
  { id: '21:9', label: 'Ultrawide', w: 21, h: 9 },
];

export const MIN_SIDE = 256;
export const MAX_SIDE = 2560;
export const MAX_PIXELS = 2560 * 1600;
/** Above this multiple of the native pixel count the image is made with a second (hires) pass. */
export const HIRES_THRESHOLD = 1.35;

const round = (n: number, step: number) => Math.max(step, Math.round(n / step) * step);

/** Fit a ratio into a pixel budget, sides multiple of 64 (latent-friendly). */
export function fitRatio(w: number, h: number, budget: number): { width: number; height: number } {
  const ratio = w / h;
  const height = Math.sqrt(budget / ratio);
  return { width: round(height * ratio, 64), height: round(height, 64) };
}

export interface SizePlan {
  width: number;
  height: number;
  /** Set when the target is well above the model's native size: generate at `base`, then upscale. */
  hires?: { base: { width: number; height: number } };
  /** Human-readable adjustment made to the request (pt-BR). */
  note?: string;
}

/** Turn a size request into concrete dimensions for a workspace. */
export function planSize(
  baseModel: BaseModel,
  defaults: { width: number; height: number },
  req: SizeRequest,
  allowHires = true,
): SizePlan {
  const budget = defaults.width * defaults.height;
  let width: number;
  let height: number;
  let note: string | undefined;
  switch (req.kind) {
    case 'auto':
      return { width: defaults.width, height: defaults.height };
    case 'aspect': {
      const preset = BASE_MODEL_PROFILES[baseModel]?.sizes[req.aspect] ?? BASE_MODEL_PROFILES.other.sizes[req.aspect];
      return fitRatio(preset.width, preset.height, budget);
    }
    case 'ratio':
      return fitRatio(req.w, req.h, budget);
    case 'exact':
      width = round(req.width, 8);
      height = round(req.height, 8);
  }
  const ratio = width / height;
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) {
    const scale = Math.min(MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / (width * height)));
    const w = round(width * scale, 8);
    const h = round(height * scale, 8);
    note = `${width}×${height} é grande demais para gerar direto; reduzi para ${w}×${h}. Para mais, use um upscaler depois.`;
    width = w;
    height = h;
  }
  if (width < MIN_SIDE || height < MIN_SIDE) {
    const scale = Math.max(MIN_SIDE / width, MIN_SIDE / height);
    width = round(width * scale, 8);
    height = round(height * scale, 8);
    note = `Tamanho mínimo é ${MIN_SIDE}px por lado; ajustei para ${width}×${height}.`;
  }
  if (allowHires && width * height > budget * HIRES_THRESHOLD) {
    const base = fitRatio(ratio, 1, budget);
    return { width, height, hires: { base }, note };
  }
  return { width, height, note };
}

const FORMAT_WORDS: Record<string, Aspect> = {
  vertical: 'portrait',
  retrato: 'portrait',
  portrait: 'portrait',
  horizontal: 'landscape',
  paisagem: 'landscape',
  landscape: 'landscape',
  quadrado: 'square',
  quadrada: 'square',
  square: 'square',
  widescreen: 'wide',
  wide: 'wide',
  'panorâmico': 'wide',
  panoramico: 'wide',
  'panorâmica': 'wide',
  panoramica: 'wide',
  wallpaper: 'wide',
  story: 'tall',
  stories: 'tall',
  reels: 'tall',
  tiktok: 'tall',
};

const WORDS = Object.keys(FORMAT_WORDS).join('|');
const FORMAT_PATTERNS = [
  // "formato vertical", "orientação paisagem", "proporção de retrato"
  new RegExp(`(?:formato|modo|orienta[cç][aã]o|propor[cç][aã]o|aspecto)\\s+(?:de\\s+)?(${WORDS})(?![a-zà-ú])`),
  // "na vertical", "em horizontal", "no formato widescreen"
  /(?:^|\s)(?:em|n[ao])\s+(?:formato\s+)?(vertical|horizontal|widescreen)(?![a-zà-ú])/,
  // "portrait format", "landscape orientation", "square aspect ratio"
  /\b(portrait|landscape|square|vertical|horizontal|wide|widescreen)\s+(?:format|orientation|mode|aspect)\b/,
  // "para o story", "pro reels", "wallpaper", "widescreen"
  /(?:^|\s)(?:para|pra|pro)\s+(?:o\s+|os\s+)?(story|stories|reels|tiktok)(?![a-zà-ú])/,
  /(?:^|\s)(widescreen|wallpaper|stories|reels)(?![a-zà-ú])/,
];

/**
 * Find an explicit size request in a chat message: "1920x1080", "16:9",
 * "formato vertical", "na horizontal", "para o story"... Words like
 * "retrato"/"paisagem" alone describe content ("um retrato de…", "uma
 * paisagem…"), so they only count next to a format cue.
 */
export function parseSizeRequest(text: string): SizeRequest | null {
  const t = text.toLowerCase();
  const exact = t.match(/(?<!\d)(\d{3,4})\s*[x×*]\s*(\d{3,4})(?!\d)/);
  if (exact) return { kind: 'exact', width: Number(exact[1]), height: Number(exact[2]) };
  for (const m of t.matchAll(/(?<![\d:.,])(\d{1,2})\s*:\s*(\d{1,2})(?![\d:])/g)) {
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (w >= 1 && h >= 1 && w <= 21 && h <= 21 && w / h >= 0.25 && w / h <= 4) return { kind: 'ratio', w, h };
  }
  for (const re of FORMAT_PATTERNS) {
    const m = t.match(re);
    if (m) return { kind: 'aspect', aspect: FORMAT_WORDS[m[1]] };
  }
  return null;
}

export function describeSizeRequest(req: SizeRequest): string {
  switch (req.kind) {
    case 'auto':
      return 'Auto';
    case 'aspect':
      return { square: 'quadrado', portrait: 'retrato', landscape: 'paisagem', wide: 'widescreen', tall: 'vertical alto' }[req.aspect];
    case 'ratio':
      return `${req.w}:${req.h}`;
    case 'exact':
      return `${req.width}×${req.height}`;
  }
}
