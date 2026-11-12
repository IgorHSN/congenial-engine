import type { Aspect, BaseModel, SamplerDefaults } from './types';

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
