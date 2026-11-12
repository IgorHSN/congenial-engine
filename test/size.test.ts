import { describe, expect, it } from 'vitest';
import { BASE_MODEL_PROFILES, fitRatio, parseSizeRequest, planSize } from '@shared/presets';
import type { Workspace } from '@shared/types';
import { buildWorkflow } from '../src/main/comfy/workflow';

const XL = { width: 1024, height: 1024 };
const SD15 = { width: 512, height: 768 };

describe('parseSizeRequest', () => {
  it.each([
    ['gere em 1920x1080 um castelo', { kind: 'exact', width: 1920, height: 1080 }],
    ['1024 × 1536px por favor', { kind: 'exact', width: 1024, height: 1536 }],
    ['quero 16:9', { kind: 'ratio', w: 16, h: 9 }],
    ['proporção 4:5 para o feed', { kind: 'ratio', w: 4, h: 5 }],
    ['formato vertical', { kind: 'aspect', aspect: 'portrait' }],
    ['agora na horizontal', { kind: 'aspect', aspect: 'landscape' }],
    ['em formato quadrado', { kind: 'aspect', aspect: 'square' }],
    ['orientação paisagem', { kind: 'aspect', aspect: 'landscape' }],
    ['faz para o story', { kind: 'aspect', aspect: 'tall' }],
    ['um wallpaper de montanhas', { kind: 'aspect', aspect: 'wide' }],
    ['portrait format, woman reading', { kind: 'aspect', aspect: 'portrait' }],
  ])('%s', (text, expected) => {
    expect(parseSizeRequest(text)).toEqual(expected);
  });

  it.each([
    'um retrato de uma mulher sorrindo',
    'uma paisagem nevada ao amanhecer',
    'castelo em paisagem montanhosa',
    'mulher em pé na praia',
    'encontro às 10:30 no café',
    'uma história de fantasia',
    'score 2 de 3',
  ])('ignores content words: %s', (text) => {
    expect(parseSizeRequest(text)).toBeNull();
  });
});

describe('planSize', () => {
  it('keeps auto at the workspace default and fits ratios into the native budget', () => {
    expect(planSize('sdxl', XL, { kind: 'auto' })).toEqual({ width: 1024, height: 1024 });
    expect(planSize('sdxl', XL, { kind: 'ratio', w: 16, h: 9 })).toEqual({ width: 1344, height: 768 });
    expect(planSize('pony', XL, { kind: 'aspect', aspect: 'portrait' })).toEqual({ width: 832, height: 1216 });
    expect(planSize('sd15', SD15, { kind: 'ratio', w: 1, h: 1 })).toEqual(fitRatio(1, 1, 512 * 768));
  });

  it('uses a hires pass above the native size and clamps huge requests', () => {
    expect(planSize('sdxl', XL, { kind: 'exact', width: 1920, height: 1080 })).toEqual({
      width: 1920,
      height: 1080,
      hires: { base: { width: 1344, height: 768 } },
      note: undefined,
    });
    const huge = planSize('sdxl', XL, { kind: 'exact', width: 3840, height: 2160 });
    expect(huge).toMatchObject({ width: 2560, height: 1440, hires: { base: { width: 1344, height: 768 } } });
    expect(huge.note).toMatch(/grande demais/);
    expect(planSize('sdxl', XL, { kind: 'exact', width: 100, height: 100 })).toMatchObject({ width: 256, height: 256 });
    // native-ish sizes are generated directly
    expect(planSize('sdxl', XL, { kind: 'exact', width: 1152, height: 896 }).hires).toBeUndefined();
    // custom workflows never get a hires pass
    expect(planSize('sdxl', XL, { kind: 'exact', width: 1920, height: 1080 }, false).hires).toBeUndefined();
  });
});

describe('hires workflow', () => {
  it('adds LatentUpscale + a second KSampler', () => {
    const ws: Workspace = {
      id: 'w',
      name: 'w',
      description: '',
      baseModel: 'sdxl',
      pipeline: 'checkpoint',
      checkpoint: 'sdxl.safetensors',
      loras: [],
      optionalLoras: [],
      defaults: BASE_MODEL_PROFILES.sdxl.defaults,
      positivePrefix: '',
      negativePrompt: '',
      refinerNotes: '',
      createdAt: '',
      updatedAt: '',
    };
    const g = buildWorkflow(ws, {
      positive: 'a',
      negative: 'b',
      width: 1344,
      height: 768,
      steps: 28,
      cfg: 6,
      seed: 7,
      batchSize: 1,
      sampler: 'euler',
      scheduler: 'normal',
      guidance: 3.5,
      clipSkip: 1,
      loras: [],
      hires: { width: 1920, height: 1080, denoise: 0.55, steps: 14 },
    });
    const nodes = Object.entries(g);
    const latent = nodes.find(([, n]) => n.class_type === 'EmptyLatentImage')![1];
    expect(latent.inputs).toMatchObject({ width: 1344, height: 768 });
    const [upId, up] = nodes.find(([, n]) => n.class_type === 'LatentUpscale')!;
    expect(up.inputs).toMatchObject({ width: 1920, height: 1080 });
    const samplers = nodes.filter(([, n]) => n.class_type === 'KSampler');
    expect(samplers).toHaveLength(2);
    expect(samplers[1][1].inputs).toMatchObject({ latent_image: [upId, 0], denoise: 0.55, steps: 14, seed: 7 });
    expect(nodes.find(([, n]) => n.class_type === 'VAEDecode')![1].inputs.samples).toEqual([samplers[1][0], 0]);
  });
});
