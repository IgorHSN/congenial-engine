import { describe, expect, it } from 'vitest';
import { BASE_MODEL_PROFILES } from '@shared/presets';
import type { Workspace } from '@shared/types';
import { buildWorkflow, fillTemplate, type GenParams } from '../src/main/comfy/workflow';

const params: GenParams = {
  positive: 'a cat',
  negative: 'blurry',
  width: 832,
  height: 1216,
  steps: 25,
  cfg: 6,
  seed: 42,
  batchSize: 2,
  sampler: 'euler_ancestral',
  scheduler: 'normal',
  guidance: 3.5,
  clipSkip: 2,
  loras: [
    { file: 'style.safetensors', strength: 0.8 },
    { file: 'detail.safetensors', strength: 0.5 },
  ],
};

function ws(partial: Partial<Workspace>): Workspace {
  return {
    id: 'w1',
    name: 'Test',
    description: '',
    baseModel: 'pony',
    pipeline: 'checkpoint',
    checkpoint: 'pony.safetensors',
    loras: [],
    optionalLoras: [],
    defaults: BASE_MODEL_PROFILES.pony.defaults,
    positivePrefix: '',
    negativePrompt: '',
    refinerNotes: '',
    createdAt: '',
    updatedAt: '',
    ...partial,
  };
}

const byClass = (g: ReturnType<typeof buildWorkflow>, cls: string) => Object.entries(g).filter(([, n]) => n.class_type === cls);

describe('buildWorkflow', () => {
  it('builds a checkpoint graph with chained LoRAs and clip skip', () => {
    const g = buildWorkflow(ws({}), params);
    const [[ckptId]] = byClass(g, 'CheckpointLoaderSimple');
    const loras = byClass(g, 'LoraLoader');
    expect(loras).toHaveLength(2);
    // first LoRA takes the checkpoint outputs, second takes the first LoRA
    expect(loras[0][1].inputs.model).toEqual([ckptId, 0]);
    expect(loras[1][1].inputs.model).toEqual([loras[0][0], 0]);
    const [[skipId, skip]] = byClass(g, 'CLIPSetLastLayer');
    expect(skip.inputs.stop_at_clip_layer).toBe(-2);
    expect(skip.inputs.clip).toEqual([loras[1][0], 1]);
    const encoders = byClass(g, 'CLIPTextEncode');
    expect(encoders.map(([, n]) => n.inputs.text)).toEqual(['a cat', 'blurry']);
    expect(encoders.every(([, n]) => (n.inputs.clip as unknown[])[0] === skipId)).toBe(true);
    const [[, sampler]] = byClass(g, 'KSampler');
    expect(sampler.inputs).toMatchObject({ seed: 42, steps: 25, cfg: 6, sampler_name: 'euler_ancestral', scheduler: 'normal' });
    expect(sampler.inputs.model).toEqual([loras[1][0], 0]);
    const [[, latent]] = byClass(g, 'EmptyLatentImage');
    expect(latent.inputs).toMatchObject({ width: 832, height: 1216, batch_size: 2 });
    expect(byClass(g, 'SaveImage')).toHaveLength(1);
  });

  it('uses the VAE override and skips zero-strength / duplicate LoRAs', () => {
    const g = buildWorkflow(ws({ vae: 'sdxl_vae.safetensors' }), {
      ...params,
      clipSkip: 1,
      loras: [
        { file: 'a.safetensors', strength: 0 },
        { file: 'b.safetensors', strength: 0.6 },
        { file: 'b.safetensors', strength: 0.9 },
      ],
    });
    expect(byClass(g, 'LoraLoader').map(([, n]) => n.inputs.strength_model)).toEqual([0.9]);
    const [[vaeId]] = byClass(g, 'VAELoader');
    expect(byClass(g, 'VAEDecode')[0][1].inputs.vae).toEqual([vaeId, 0]);
    expect(byClass(g, 'CLIPSetLastLayer')).toHaveLength(0);
  });

  it('builds a Flux graph with guidance, SD3 latent and cfg 1', () => {
    const g = buildWorkflow(
      ws({ baseModel: 'flux', pipeline: 'flux', checkpoint: undefined, unet: 'flux1-dev-fp8.safetensors', clip1: 'clip_l.safetensors', clip2: 't5xxl_fp8.safetensors', vae: 'ae.safetensors' }),
      { ...params, loras: [] },
    );
    expect(byClass(g, 'UNETLoader')).toHaveLength(1);
    expect(byClass(g, 'DualCLIPLoader')[0][1].inputs).toMatchObject({ type: 'flux' });
    expect(byClass(g, 'FluxGuidance')[0][1].inputs.guidance).toBe(3.5);
    expect(byClass(g, 'EmptySD3LatentImage')).toHaveLength(1);
    expect(byClass(g, 'KSampler')[0][1].inputs.cfg).toBe(1);
    expect(byClass(g, 'CLIPSetLastLayer')).toHaveLength(0);
    // negative is ignored by Flux
    expect(byClass(g, 'CLIPTextEncode').map(([, n]) => n.inputs.text)).toEqual(['a cat', '']);
  });
});

describe('fillTemplate', () => {
  it('replaces placeholders and converts numeric ones', () => {
    const g = fillTemplate(
      {
        '3': { class_type: 'KSampler', inputs: { seed: '{{seed}}', steps: '{{steps}}', cfg: '{{cfg}}' } },
        '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, {{positive}}' } },
        '7': { class_type: 'CLIPTextEncode', inputs: { text: '{{negative}}' } },
        '5': { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: '{{batch_size}}' } },
      },
      params,
    );
    expect(g['3'].inputs).toEqual({ seed: 42, steps: 25, cfg: 6 });
    expect(g['6'].inputs.text).toBe('masterpiece, a cat');
    expect(g['7'].inputs.text).toBe('blurry');
    expect(g['5'].inputs).toEqual({ width: 832, height: 1216, batch_size: 2 });
  });

  it('rejects UI-format workflows', () => {
    expect(() => fillTemplate({ nodes: [], links: [] } as never, params)).toThrow(/formato API/);
  });
});
