import { describe, expect, it } from 'vitest';
import { templateFromApiWorkflow } from '../src/main/comfy/importWorkflow';
import { fillTemplate, type GenParams } from '../src/main/comfy/workflow';

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }>;
const node = (class_type: string, inputs: Record<string, unknown>, title?: string) => ({ class_type, inputs, ...(title ? { _meta: { title } } : {}) });

const params: GenParams = {
  positive: 'APP POSITIVE',
  negative: 'APP NEGATIVE',
  width: 896,
  height: 1152,
  steps: 11,
  cfg: 4.5,
  seed: 999,
  batchSize: 3,
  sampler: 'dpmpp_2m',
  scheduler: 'karras',
  guidance: 2.5,
  clipSkip: 1,
  loras: [],
};

/** Classic SDXL export with a second (hires) sampler. */
function sdxlGraph(): Graph {
  return {
    '4': node('CheckpointLoaderSimple', { ckpt_name: 'ponyV6.safetensors' }),
    '10': node('LoraLoader', { model: ['4', 0], clip: ['4', 1], lora_name: 'style.safetensors', strength_model: 0.8, strength_clip: 0.8 }),
    '6': node('CLIPTextEncode', { text: 'a cat on a sofa', clip: ['10', 1] }),
    '7': node('CLIPTextEncode', { text: 'blurry, lowres', clip: ['10', 1] }),
    '5': node('EmptyLatentImage', { width: 832, height: 1216, batch_size: 2 }),
    '3': node('KSampler', {
      seed: 123,
      steps: 28,
      cfg: 6,
      sampler_name: 'euler_ancestral',
      scheduler: 'normal',
      denoise: 1,
      model: ['10', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    }),
    '11': node('LatentUpscale', { samples: ['3', 0], upscale_method: 'nearest-exact', width: 1664, height: 2432, crop: 'disabled' }),
    '12': node('KSampler', {
      seed: 5,
      steps: 15,
      cfg: 6,
      sampler_name: 'euler',
      scheduler: 'normal',
      denoise: 0.5,
      model: ['10', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['11', 0],
    }),
    '8': node('VAEDecode', { samples: ['12', 0], vae: ['4', 2] }),
    '9': node('SaveImage', { filename_prefix: 'ComfyUI', images: ['8', 0] }),
  };
}

describe('importing an API-format workflow', () => {
  it('puts placeholders on the main sampler, prompts and empty latent', () => {
    const imp = templateFromApiWorkflow(sdxlGraph(), 'pony');
    const g = imp.workflow as Graph;
    expect(g['6'].inputs.text).toBe('{{positive}}');
    expect(g['7'].inputs.text).toBe('{{negative}}');
    expect(g['3'].inputs).toMatchObject({ seed: '{{seed}}', steps: '{{steps}}', cfg: '{{cfg}}', sampler_name: '{{sampler}}', scheduler: '{{scheduler}}' });
    expect(g['5'].inputs).toMatchObject({ width: '{{width}}', height: '{{height}}', batch_size: '{{batch_size}}' });
    // The hires pass keeps its own settings.
    expect(g['12'].inputs).toMatchObject({ seed: 5, steps: 15, sampler_name: 'euler', denoise: 0.5 });
    expect(g['11'].inputs.width).toBe(1664);

    expect(imp).toMatchObject({
      name: 'pony',
      positive: 'a cat on a sofa',
      negative: 'blurry, lowres',
      usesNegative: true,
      defaults: { steps: 28, cfg: 6, sampler: 'euler_ancestral', scheduler: 'normal', width: 832, height: 1216, batchSize: 2 },
      models: { checkpoint: 'ponyV6.safetensors', loras: ['style.safetensors'] },
      warnings: [],
    });
    expect(imp.replaced.some((r) => r.startsWith('prompt positivo: CLIPTextEncode (#6)'))).toBe(true);

    // The result is a valid template for the custom pipeline.
    const filled = fillTemplate(imp.workflow, params);
    expect(filled['3'].inputs).toMatchObject({ seed: 999, steps: 11, cfg: 4.5, sampler_name: 'dpmpp_2m', scheduler: 'karras' });
    expect(filled['5'].inputs).toMatchObject({ width: 896, height: 1152, batch_size: 3 });
    expect(filled['6'].inputs.text).toBe('APP POSITIVE');
    expect(filled['7'].inputs.text).toBe('APP NEGATIVE');
  });

  it('handles wired values, a zeroed negative and preview-only outputs (Z-Image style)', () => {
    const imp = templateFromApiWorkflow({
      '1': node('UNETLoader', { unet_name: 'z_image_turbo_bf16.safetensors', weight_dtype: 'default' }),
      '2': node('CLIPLoader', { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2' }),
      '3': node('VAELoader', { vae_name: 'ae.safetensors' }),
      '4': node('ModelSamplingAuraFlow', { model: ['1', 0], shift: 3 }),
      '5': node('PrimitiveStringMultiline', { value: 'a lighthouse at dusk' }, 'Prompt'),
      '6': node('CLIPTextEncode', { text: ['5', 0], clip: ['2', 0] }),
      '7': node('ConditioningZeroOut', { conditioning: ['6', 0] }),
      '20': node('ResolutionSelector', { aspect: '1:1', base: 1024 }),
      '21': node('Seed (rgthree)', { seed: 42 }),
      '8': node('EmptySD3LatentImage', { width: ['20', 0], height: ['20', 1], batch_size: 1 }),
      '9': node('KSampler', {
        seed: ['21', 0],
        steps: 8,
        cfg: 1,
        sampler_name: 'res_multistep',
        scheduler: 'simple',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['8', 0],
      }),
      '10': node('VAEDecode', { samples: ['9', 0], vae: ['3', 0] }),
      '11': node('PreviewImage', { images: ['10', 0] }),
    });
    const g = imp.workflow as Graph;
    // Values wired from a primitive are replaced in the primitive.
    expect(g['5'].inputs.value).toBe('{{positive}}');
    expect(g['6'].inputs.text).toEqual(['5', 0]);
    expect(g['21'].inputs.seed).toBe('{{seed}}');
    expect(imp.positive).toBe('a lighthouse at dusk');
    // The negative is zeroed out: nothing to replace, nothing to warn about.
    expect(imp.usesNegative).toBe(false);
    expect(imp.warnings.some((w) => /negativo/.test(w))).toBe(false);
    // Size computed by another node: the wire is cut and the user is told.
    expect(g['8'].inputs).toMatchObject({ width: '{{width}}', height: '{{height}}', batch_size: '{{batch_size}}' });
    expect(imp.warnings.filter((w) => w.includes('ResolutionSelector (#20)'))).toHaveLength(2);
    expect(imp.defaults).toEqual({ steps: 8, cfg: 1, sampler: 'res_multistep', scheduler: 'simple', batchSize: 1 });
    // The model is found through ModelSamplingAuraFlow.
    expect(imp.models).toEqual({ unet: 'z_image_turbo_bf16.safetensors', loras: [] });
    // Preview-only workflows save their images so the app gets them.
    expect(g['11']).toMatchObject({ class_type: 'SaveImage', inputs: { filename_prefix: 'atelier', images: ['10', 0] } });
  });

  it('follows SamplerCustomAdvanced to its noise, guider, sampler and sigmas (Flux)', () => {
    const imp = templateFromApiWorkflow({
      '1': node('UNETLoader', { unet_name: 'flux1-dev.safetensors', weight_dtype: 'default' }),
      '2': node('DualCLIPLoader', { clip_name1: 'clip_l.safetensors', clip_name2: 't5xxl.safetensors', type: 'flux' }),
      '6': node('CLIPTextEncode', { text: 'portrait of a sailor', clip: ['2', 0] }),
      '26': node('FluxGuidance', { guidance: 3.5, conditioning: ['6', 0] }),
      '22': node('BasicGuider', { model: ['1', 0], conditioning: ['26', 0] }),
      '25': node('RandomNoise', { noise_seed: 7 }),
      '16': node('KSamplerSelect', { sampler_name: 'euler' }),
      '17': node('BasicScheduler', { scheduler: 'simple', steps: 20, denoise: 1, model: ['1', 0] }),
      '27': node('EmptySD3LatentImage', { width: 1024, height: 1024, batch_size: 1 }),
      '13': node('SamplerCustomAdvanced', { noise: ['25', 0], guider: ['22', 0], sampler: ['16', 0], sigmas: ['17', 0], latent_image: ['27', 0] }),
      '8': node('VAEDecode', { samples: ['13', 0], vae: ['10', 0] }),
      '10': node('VAELoader', { vae_name: 'ae.safetensors' }),
      '9': node('SaveImage', { filename_prefix: 'flux', images: ['8', 0] }),
    });
    const g = imp.workflow as Graph;
    expect(g['25'].inputs.noise_seed).toBe('{{seed}}');
    expect(g['16'].inputs.sampler_name).toBe('{{sampler}}');
    expect(g['17'].inputs).toMatchObject({ steps: '{{steps}}', scheduler: '{{scheduler}}', denoise: 1 });
    expect(g['26'].inputs.guidance).toBe('{{guidance}}');
    expect(g['6'].inputs.text).toBe('{{positive}}');
    expect(imp).toMatchObject({
      usesNegative: false,
      defaults: { steps: 20, sampler: 'euler', scheduler: 'simple', guidance: 3.5, width: 1024, height: 1024, batchSize: 1 },
      models: { unet: 'flux1-dev.safetensors' },
      warnings: [],
    });
    expect(fillTemplate(imp.workflow, params)['26'].inputs.guidance).toBe(2.5);
  });

  it('cuts a prompt built by other nodes and warns', () => {
    const graph = sdxlGraph();
    graph['30'] = node('StringConcatenate', { string_a: 'trigger, ', string_b: 'a cat', delimiter: '' });
    graph['6'].inputs.text = ['30', 0];
    const imp = templateFromApiWorkflow(graph);
    expect((imp.workflow as Graph)['6'].inputs.text).toBe('{{positive}}');
    expect(imp.warnings).toEqual(['O prompt positivo vinha do nó StringConcatenate (#30); agora quem define é o app.']);
  });

  it('explains what is wrong with other files', () => {
    expect(() => templateFromApiWorkflow({ nodes: [], links: [] })).toThrow(/Export \(API\)/);
    expect(() => templateFromApiWorkflow({ foo: 1 })).toThrow(/Export \(API\)/);
    expect(() => templateFromApiWorkflow([])).toThrow(/inválido/);
    const noSampler = templateFromApiWorkflow({ '1': node('LoadImage', { image: 'a.png' }) });
    expect(noSampler.warnings[0]).toMatch(/sampler principal/);
    expect(noSampler.warnings[1]).toMatch(/salve imagens/);
  });
});
