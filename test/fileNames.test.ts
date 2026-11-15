import { afterEach, describe, expect, it } from 'vitest';
import type { InstalledModel } from '@shared/types';
import { ComfyClient } from '../src/main/comfy/client';
import { lorasNamedIn } from '../src/main/generation/session';
import { startFakeComfy } from './helpers/fakeServers';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('model file names sent to ComfyUI', () => {
  it('uses the exact spelling the server lists (Windows separators, both COMBO formats)', async () => {
    const server = await startFakeComfy({
      objectInfo: {
        LoraLoader: {
          name: 'LoraLoader',
          input: { required: { lora_name: [['plain.safetensors', 'Unknown\\no tags\\shexyo.safetensors']], strength_model: ['FLOAT', {}] } },
        },
        UNETLoader: {
          name: 'UNETLoader',
          input: { required: { unet_name: ['COMBO', { options: ['anima\\base.safetensors'] }], weight_dtype: [['default']] } },
        },
      },
    });
    cleanups.push(server.close);
    const client = new ComfyClient(() => server.url);
    const graph = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: 'anima/base.safetensors', weight_dtype: 'default' } },
      '2': { class_type: 'LoraLoader', inputs: { lora_name: 'Unknown/no tags/shexyo.safetensors', model: ['1', 0], strength_model: 1 } },
      '3': { class_type: 'LoraLoader', inputs: { lora_name: 'missing/other.safetensors', model: ['2', 0] } },
      '4': { class_type: 'CLIPTextEncode', inputs: { text: 'a/b test' } },
      '5': { class_type: 'SomethingUnknown', inputs: { path: 'x/y' } },
    };
    await client.queuePrompt(graph, 'c1');
    const sent = server.prompts[0];
    expect(sent['1'].inputs.unet_name).toBe('anima\\base.safetensors');
    expect(sent['2'].inputs.lora_name).toBe('Unknown\\no tags\\shexyo.safetensors');
    // Not listed by the server, not a combo, or no node info: left as it was.
    expect(sent['3'].inputs.lora_name).toBe('missing/other.safetensors');
    expect(sent['4'].inputs.text).toBe('a/b test');
    expect(sent['5'].inputs.path).toBe('x/y');
  });
});

describe('optional LoRAs without the local LLM', () => {
  const lora = (file: string, triggerWords: string[] = []): InstalledModel => ({ folder: 'loras', file, path: file, sizeBytes: 1, meta: { triggerWords } });
  const candidates = [
    { file: 'Unknown/no tags/Mai Shiranui.safetensors', strength: 0.8 },
    { file: 'Unknown/no tags/Angewomon.safetensors', strength: 0.8 },
    { file: 'anima3d_style_dim48_lr3e5-000009.safetensors', strength: 0.6 },
    { file: 'ink_v2.safetensors', strength: 0.7 },
  ];
  const inventory = [lora('ink_v2.safetensors', ['inkwash style'])];

  it('picks the ones the text names, by file name words or trigger words', () => {
    expect(lorasNamedIn('sh3xy0 style, shiranui mai, Angewomon, face to face', candidates, inventory).map((l) => l.file)).toEqual([
      'Unknown/no tags/Mai Shiranui.safetensors',
      'Unknown/no tags/Angewomon.safetensors',
    ]);
    expect(lorasNamedIn('a cat, Inkwash Style, sunset', candidates, inventory).map((l) => l.file)).toEqual(['ink_v2.safetensors']);
  });

  it('does not pick on partial names', () => {
    expect(lorasNamedIn('mai at the beach, anima style', candidates, inventory)).toEqual([]);
    expect(lorasNamedIn('inkwash', candidates, inventory)).toEqual([]);
  });
});
