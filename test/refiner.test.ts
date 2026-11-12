import { describe, expect, it } from 'vitest';
import { BASE_MODEL_PROFILES } from '@shared/presets';
import type { Workspace } from '@shared/types';
import {
  buildRefinerMessages,
  buildRefinerSystemPrompt,
  extractJson,
  joinPrompt,
  parseRefined,
  RefinerParseError,
} from '../src/main/generation/refiner';
import { checkSafety, isSexual } from '../src/main/generation/safety';
import { stripThinking } from '../src/main/generation/llm';

const ws: Workspace = {
  id: 'w',
  name: 'Pony',
  description: '',
  baseModel: 'pony',
  pipeline: 'checkpoint',
  checkpoint: 'pony.safetensors',
  loras: [{ file: 'detail.safetensors', strength: 0.6 }],
  optionalLoras: [{ file: 'watercolor.safetensors', strength: 0.8 }],
  defaults: BASE_MODEL_PROFILES.pony.defaults,
  positivePrefix: BASE_MODEL_PROFILES.pony.positivePrefix,
  negativePrompt: BASE_MODEL_PROFILES.pony.negativePrompt,
  refinerNotes: 'anime look',
  createdAt: '',
  updatedAt: '',
};

describe('refiner prompt', () => {
  it('describes the model family, prefix, LoRAs and hard rules', () => {
    const sys = buildRefinerSystemPrompt({
      workspace: ws,
      fixedLoras: [{ ...ws.loras[0], triggerWords: ['detailed'] }],
      optionalLoras: [{ ...ws.optionalLoras[0], triggerWords: ['wtrcolor'], description: 'watercolor painting style' }],
    });
    expect(sys).toContain('Pony Diffusion');
    expect(sys).toContain('score_9, score_8_up, score_7_up');
    expect(sys).toContain('file: "watercolor.safetensors"');
    expect(sys).toContain('trigger words: wtrcolor');
    expect(sys).toContain('anime look');
    expect(sys).toMatch(/Every person depicted is an adult/);
  });

  it('replays previous turns as assistant JSON so the LLM can iterate', () => {
    const msgs = buildRefinerMessages('SYS', [{ user: 'a knight', refined: { positive: '1girl, knight', negative: '' } }], 'now at night');
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(JSON.parse(msgs[2].content).positive).toBe('1girl, knight');
    expect(msgs[3].content).toBe('now at night');
  });
});

describe('parseRefined', () => {
  const allowed = ws.optionalLoras;

  it('parses fenced JSON with think tags and filters unknown LoRAs', () => {
    const raw =
      '<think>hmm</think>Here you go:\n```json\n{"positive":"1girl, watercolor","negative":"","aspect":"portrait","batch_size":2,"seed":null,' +
      '"loras":[{"file":"watercolor.safetensors","strength":0.7},{"file":"evil.safetensors","strength":1}],"comment":"Feito","refused":false}\n```';
    const r = parseRefined(raw, allowed);
    expect(r.refused).toBe(false);
    if (r.refused) return;
    expect(r.prompt).toMatchObject({ positive: '1girl, watercolor', aspect: 'portrait', batchSize: 2, comment: 'Feito' });
    expect(r.prompt.seed).toBeUndefined();
    expect(r.prompt.loras).toEqual([{ file: 'watercolor.safetensors', strength: 0.7 }]);
  });

  it('returns refusals', () => {
    const r = parseRefined('{"positive":"","negative":"","aspect":"square","comment":"","refused":true,"refusal_reason":"minor"}', allowed);
    expect(r).toEqual({ refused: true, reason: 'minor' });
  });

  it('throws on garbage or empty prompts', () => {
    expect(() => parseRefined('not json at all', allowed)).toThrow(RefinerParseError);
    expect(() => parseRefined('{"positive":"  ","refused":false}', allowed)).toThrow(RefinerParseError);
  });

  it('tolerates trailing commas', () => {
    expect(extractJson('{"a": [1, 2,],}')).toEqual({ a: [1, 2] });
  });
});

describe('joinPrompt', () => {
  it('drops empties and duplicate tags case-insensitively', () => {
    expect(joinPrompt('score_9, score_8_up', '', 'Score_9, 1girl, solo', undefined)).toBe('score_9, score_8_up, 1girl, solo');
  });
});

describe('safety', () => {
  it('allows adult NSFW content', () => {
    expect(checkSafety('mulher adulta nua na praia', 'adult woman, nude, beach, rating_explicit').allowed).toBe(true);
  });
  it('allows non-sexual content with children', () => {
    expect(checkSafety('a mother walking with her child in the park').allowed).toBe(true);
  });
  it('blocks sexual content combined with minors (en / pt / ages / tags)', () => {
    expect(checkSafety('nude child').allowed).toBe(false);
    expect(checkSafety('loli, rating_explicit').allowed).toBe(false);
    expect(checkSafety('menina de 15 anos pelada').allowed).toBe(false);
    expect(checkSafety('sexy girl, 16 years old').allowed).toBe(false);
    expect(checkSafety('criança', 'nsfw').allowed).toBe(false);
  });
  it('detects sexual content', () => {
    expect(isSexual('1girl, (nude:1.2), bedroom')).toBe(true);
    expect(isSexual('a red apple on a wooden table')).toBe(false);
  });
});

describe('stripThinking', () => {
  it('removes reasoning blocks', () => {
    expect(stripThinking('<think>a\nb</think>\n{"x":1}')).toBe('{"x":1}');
  });
});
