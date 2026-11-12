import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectComfy } from '../src/main/comfy/detect';
import { ModelInventory } from '../src/main/comfy/inventory';
import { expandPath, parseExtraModelPaths, rootFromModelsDir } from '../src/main/comfy/modelDirs';
import { baseModelFromName, detectMeta, metaFromSafetensors, readSafetensorsHeader } from '../src/main/comfy/modelMeta';
import { summarizeWorkflow } from '../src/main/comfy/workflows';
import { loraCompatible } from '@shared/presets';
import { startFakeComfy } from './helpers/fakeServers';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** Write a minimal valid .safetensors file with the given metadata and tensor names. */
function writeSafetensors(path: string, metadata: Record<string, string>, keys: string[]): void {
  const header: Record<string, unknown> = { __metadata__: metadata };
  keys.forEach((k, i) => (header[k] = { dtype: 'F16', shape: [1], data_offsets: [i * 2, i * 2 + 2] }));
  const json = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  writeFileSync(path, Buffer.concat([len, json, Buffer.alloc(keys.length * 2)]));
}

describe('extra_model_paths.yaml', () => {
  it('resolves paths like ComfyUI does', () => {
    const yamlDir = normalize('/opt/ComfyUI');
    const parsed = parseExtraModelPaths(
      `
a111:
    base_path: ../stable-diffusion-webui/
    checkpoints: models/Stable-diffusion
    loras: |
         models/Lora
         models/LyCORIS
    clip: models/text_encoder
other:
    base_path: $MODELS_HOME
    is_default: true
    loras: loras
relative:
    vae: shared/vae
`,
      yamlDir,
      { MODELS_HOME: normalize('/data/models') },
    );
    expect(parsed.checkpoints).toEqual([normalize('/opt/stable-diffusion-webui/models/Stable-diffusion')]);
    // is_default entries go first
    expect(parsed.loras).toEqual([
      normalize('/data/models/loras'),
      normalize('/opt/stable-diffusion-webui/models/Lora'),
      normalize('/opt/stable-diffusion-webui/models/LyCORIS'),
    ]);
    // legacy "clip" key maps to text_encoders
    expect(parsed.text_encoders).toEqual([normalize('/opt/stable-diffusion-webui/models/text_encoder')]);
    expect(parsed.vae).toEqual([normalize('/opt/ComfyUI/shared/vae')]);
  });

  it('expands ~ and env vars', () => {
    expect(expandPath('~/models')).toBe(join(homedir(), 'models'));
    expect(expandPath('%X%/a', { X: 'C:' })).toBe('C:/a');
    expect(expandPath('${Y}/b', { Y: '/y' })).toBe('/y/b');
  });

  it('derives the ComfyUI root from a models dir', () => {
    expect(rootFromModelsDir('/home/u/ComfyUI/models/checkpoints')).toBe('/home/u/ComfyUI');
    expect(rootFromModelsDir('/nowhere')).toBeNull();
  });
});

describe('ModelInventory across folders', () => {
  it('lists default, yaml and server folders, first match wins, and locates files', async () => {
    const root = tmp('atelier-root-');
    const a1111 = tmp('atelier-a1111-');
    const server = tmp('atelier-server-');
    mkdirSync(join(root, 'models', 'loras'), { recursive: true });
    mkdirSync(join(a1111, 'models', 'Lora', 'styles'), { recursive: true });
    writeFileSync(join(root, 'models', 'loras', 'shared.safetensors'), 'primary');
    writeFileSync(join(a1111, 'models', 'Lora', 'shared.safetensors'), 'shadowed');
    writeFileSync(join(a1111, 'models', 'Lora', 'styles', 'ink.safetensors'), 'x');
    writeFileSync(join(a1111, 'models', 'Lora', 'readme.txt'), 'not a model');
    writeFileSync(join(server, 'flux_lora.safetensors'), 'x');
    writeFileSync(join(root, 'extra_model_paths.yaml'), `a111:\n  base_path: ${a1111}\n  loras: models/Lora\n`);

    const inv = new ModelInventory(tmp('atelier-data-'), () => root, async () => ({ loras: [join(root, 'models', 'loras'), server] }));
    const loras = await inv.list('loras');
    expect(loras.map((m) => m.file)).toEqual(['flux_lora.safetensors', 'shared.safetensors', 'styles/ink.safetensors']);
    expect(loras.find((m) => m.file === 'shared.safetensors')!.path).toBe(join(root, 'models', 'loras', 'shared.safetensors'));
    expect(await inv.locate('loras', 'styles/ink.safetensors')).toBe(join(a1111, 'models', 'Lora', 'styles', 'ink.safetensors'));
    expect(await inv.exists('loras', 'flux_lora.safetensors')).toBe(true);
    expect(await inv.exists('loras', '../escape.safetensors')).toBe(false);
  });

  it('auto-detects metadata offline and lets explicit metadata win', async () => {
    const root = tmp('atelier-root-');
    const dir = join(root, 'models', 'loras');
    mkdirSync(dir, { recursive: true });
    writeSafetensors(
      join(dir, 'cute_style.safetensors'),
      {
        ss_base_model_version: 'sdxl_base_v1-0',
        ss_sd_model_name: 'ponyDiffusionV6XL_v6.safetensors',
        ss_tag_frequency: JSON.stringify({ '10_cutestyle': { cutestyle: 40, '1girl': 30, smile: 5 }, extra: { '1girl': 20 } }),
      },
      ['lora_unet_input_blocks_4_1_proj_in.lora_down.weight', 'lora_te2_text_model_encoder_layers_0.lora_down.weight'],
    );
    writeFileSync(join(dir, 'helper.safetensors'), 'not really safetensors');
    writeFileSync(
      join(dir, 'helper.civitai.info'),
      JSON.stringify({ id: 22, modelId: 11, name: 'v2', baseModel: 'Illustrious', trainedWords: ['hlp style'], model: { name: 'Helper', nsfw: false } }),
    );
    writeFileSync(join(dir, 'manager.safetensors'), 'x');
    writeFileSync(
      join(dir, 'manager.metadata.json'),
      JSON.stringify({ base_model: 'Flux.1 D', model_name: 'Manager LoRA', usage_tips: '{"strength": 0.65}', civitai: { trainedWords: ['mgr'], id: 5, modelId: 4 } }),
    );
    writeFileSync(join(dir, 'old.safetensors'), 'x');
    writeFileSync(join(dir, 'old.json'), JSON.stringify({ 'sd version': 'SD1', 'activation text': 'oldtrig, another', 'preferred weight': 0.7, description: '' }));

    const inv = new ModelInventory(tmp('atelier-data-'), () => root);
    const byFile = Object.fromEntries((await inv.list('loras')).map((m) => [m.file, m.meta]));
    expect(byFile['cute_style.safetensors']).toMatchObject({ baseModel: 'pony', detectedFrom: 'safetensors', trainingTags: ['1girl', 'cutestyle', 'smile'] });
    expect(byFile['helper.safetensors']).toMatchObject({ baseModel: 'illustrious', triggerWords: ['hlp style'], detectedFrom: 'civitai-info' });
    expect(byFile['helper.safetensors'].source?.civitaiVersionId).toBe(22);
    expect(byFile['manager.safetensors']).toMatchObject({ baseModel: 'flux', triggerWords: ['mgr'], recommendedStrength: 0.65 });
    expect(byFile['old.safetensors']).toMatchObject({ baseModel: 'sd15', triggerWords: ['oldtrig', 'another'], recommendedStrength: 0.7 });

    await inv.setMeta('loras', 'cute_style.safetensors', { baseModel: 'illustrious', triggerWords: ['cutestyle'] });
    const after = await inv.getMeta('loras', 'cute_style.safetensors');
    expect(after).toMatchObject({ baseModel: 'illustrious', triggerWords: ['cutestyle'], trainingTags: ['1girl', 'cutestyle', 'smile'] });
    expect(after.detectedFrom).toBeUndefined();
  });

  it('recognizes architectures from tensor names', async () => {
    const dir = tmp('atelier-st-');
    const flux = join(dir, 'f.safetensors');
    writeSafetensors(flux, {}, ['lora_unet_double_blocks_0_img_attn_proj.lora_down.weight']);
    const sd15 = join(dir, 'c.safetensors');
    writeSafetensors(sd15, {}, ['cond_stage_model.transformer.text_model.embeddings.position_ids', 'model.diffusion_model.input_blocks.0.0.weight']);
    const xl = join(dir, 'x.safetensors');
    writeSafetensors(xl, { 'modelspec.trigger_phrase': 'zzz, yyy' }, ['conditioner.embedders.1.model.ln_final.weight']);
    expect(metaFromSafetensors((await readSafetensorsHeader(flux))!, 'loras', 'f').baseModel).toBe('flux');
    expect(metaFromSafetensors((await readSafetensorsHeader(sd15))!, 'checkpoints', 'c').baseModel).toBe('sd15');
    const xlMeta = metaFromSafetensors((await readSafetensorsHeader(xl))!, 'checkpoints', 'waiNSFWIllustrious_v14');
    expect(xlMeta).toMatchObject({ baseModel: 'illustrious', triggerWords: ['zzz', 'yyy'] });
    expect(await readSafetensorsHeader(join(dir, 'missing.safetensors'))).toBeNull();
    // falls back to the file name
    writeFileSync(join(dir, 'noobaiXL_vPred.ckpt'), 'x');
    expect((await detectMeta(join(dir, 'noobaiXL_vPred.ckpt'), 'checkpoints', 'noobaiXL_vPred.ckpt')).baseModel).toBe('noobai');
    expect(baseModelFromName('realisticVisionV60_sd15.safetensors')).toBe('sd15');
  });

  it('flags incompatible LoRAs', () => {
    expect(loraCompatible('sd15', 'sdxl')).toBe('no');
    expect(loraCompatible('pony', 'illustrious')).toBe('maybe');
    expect(loraCompatible('flux', 'flux')).toBe('yes');
    expect(loraCompatible(undefined, 'pony')).toBe('maybe');
  });
});

describe('workflow import', () => {
  const ui = {
    last_node_id: 12,
    nodes: [
      { id: 4, type: 'CheckpointLoaderSimple', mode: 0, widgets_values: ['waiIllustrious_v14.safetensors'] },
      { id: 10, type: 'LoraLoader', mode: 0, widgets_values: ['detail_slider.safetensors', 0.8, 0.8] },
      { id: 11, type: 'LoraLoader', mode: 4, widgets_values: ['bypassed.safetensors', 1, 1] },
      {
        id: 12,
        type: 'Power Lora Loader (rgthree)',
        mode: 0,
        widgets_values: [{}, { type: 'PowerLoraLoaderHeaderWidget' }, { on: true, lora: 'stack_a.safetensors', strength: 0.6, strengthTwo: null }, { on: false, lora: 'stack_b.safetensors', strength: 1 }, {}, ''],
      },
      { id: 5, type: 'EmptyLatentImage', mode: 0, widgets_values: [832, 1216, 1] },
      { id: 3, type: 'KSampler', mode: 0, widgets_values: [123, 'randomize', 28, 5.5, 'euler_ancestral', 'normal', 1] },
      { id: 9, type: 'CLIPSetLastLayer', mode: 0, widgets_values: [-2] },
      { id: 6, type: 'CLIPTextEncode', mode: 0, widgets_values: ['masterpiece, best quality, 1girl'] },
      { id: 7, type: 'CLIPTextEncode', mode: 0, widgets_values: ['lowres, bad anatomy'] },
      { id: 8, type: 'VAEDecode', mode: 0, widgets_values: [] },
      { id: 13, type: 'SaveImage', mode: 0, widgets_values: ['ComfyUI'] },
    ],
    links: [],
  };

  it('summarizes UI-format workflows', () => {
    const s = summarizeWorkflow(ui);
    expect(s.format).toBe('ui');
    if (s.format !== 'ui') return;
    expect(s.extracted.checkpoint).toBe('waiIllustrious_v14.safetensors');
    expect(s.extracted.sampler).toMatchObject({ steps: 28, cfg: 5.5, sampler: 'euler_ancestral', scheduler: 'normal' });
    expect(s.extracted.latent).toEqual({ width: 832, height: 1216, batchSize: 1 });
    expect(s.extracted.clipSkip).toBe(2);
    expect(s.extracted.prompts).toHaveLength(2);
    expect(s.extracted.loras.map((l) => [l.file, l.strength, l.enabled])).toEqual([
      ['detail_slider.safetensors', 0.8, true],
      ['stack_a.safetensors', 0.6, true],
      ['stack_b.safetensors', 1, false],
    ]);
    expect(s.standardPipeline).toBe(false);
    expect(s.nonStandardNodes).toEqual(['Power Lora Loader (rgthree)']);
    expect(s.disabledNodes).toEqual(['LoraLoader#11']);
  });

  it('summarizes API-format workflows and returns the JSON', () => {
    const api = {
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
      '10': { class_type: 'LoraLoader', inputs: { lora_name: 'x.safetensors', strength_model: 0.5, strength_clip: 0.5, model: ['4', 0], clip: ['4', 1] } },
      '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
    };
    const s = summarizeWorkflow(api);
    expect(s.format).toBe('api');
    if (s.format !== 'api') return;
    expect(s.standardPipeline).toBe(true);
    expect(s.extracted.loras[0]).toMatchObject({ file: 'x.safetensors', strength: 0.5 });
    expect(JSON.parse(s.json)).toEqual(api);
  });

  it('rejects non-workflow JSON', () => {
    expect(() => summarizeWorkflow({ hello: 'world' })).toThrow();
  });
});

describe('detectComfy', () => {
  it('finds the install through a running server', async () => {
    const root = tmp('atelier-detect-');
    mkdirSync(join(root, 'models', 'checkpoints'), { recursive: true });
    writeFileSync(join(root, 'main.py'), '');
    const server = await startFakeComfy({ folderPaths: { checkpoints: [join(root, 'models', 'checkpoints')], loras: [] } });
    cleanups.push(server.close);
    const found = await detectComfy(server.url);
    expect(found).toMatchObject({ url: server.url, rootPath: root, via: 'running-server' });
  });

  it('reports a reachable server without folder info', async () => {
    const server = await startFakeComfy();
    cleanups.push(server.close);
    const found = await detectComfy(server.url);
    expect(found.url).toBe(server.url);
  });
});
