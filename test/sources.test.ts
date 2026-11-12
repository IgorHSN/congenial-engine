import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectComfyLayout, safeJoin, sanitizeFileName } from '../src/main/comfy/paths';
import { splitArgs } from '../src/main/comfy/process';
import { civitaiBaseModel, civitaiFolder, parseCivitaiRef, pickCivitaiFile, stripHtml } from '../src/main/sources/civitai';
import { redact } from '../src/main/sources/downloader';
import { parseHfUrl } from '../src/main/sources/huggingface';

describe('civitai helpers', () => {
  it('parses model and version references', () => {
    expect(parseCivitaiRef('https://civitai.com/models/4201/realistic-vision?modelVersionId=130072')).toEqual({
      modelId: 4201,
      versionId: 130072,
    });
    expect(parseCivitaiRef('https://civitai.green/models/123')).toEqual({ modelId: 123 });
    expect(parseCivitaiRef('https://civitai.com/api/download/models/999')).toEqual({ versionId: 999 });
    expect(parseCivitaiRef('42')).toEqual({ modelId: 42 });
    expect(parseCivitaiRef('https://example.com/models/1')).toBeNull();
  });

  it('maps base models and types', () => {
    expect(civitaiBaseModel('Pony')).toBe('pony');
    expect(civitaiBaseModel('Illustrious')).toBe('illustrious');
    expect(civitaiBaseModel('NoobAI')).toBe('noobai');
    expect(civitaiBaseModel('Flux.1 D')).toBe('flux');
    expect(civitaiBaseModel('SD 1.5')).toBe('sd15');
    expect(civitaiBaseModel('SDXL 1.0')).toBe('sdxl');
    expect(civitaiBaseModel('SD 3.5 Large')).toBe('sd35');
    expect(civitaiFolder('Checkpoint')).toBe('checkpoints');
    expect(civitaiFolder('LORA')).toBe('loras');
    expect(civitaiFolder('LoCon')).toBe('loras');
    expect(civitaiFolder('TextualInversion')).toBe('embeddings');
    expect(civitaiFolder('Upscaler')).toBe('upscale_models');
  });

  it('prefers the primary safetensors model file', () => {
    const file = pickCivitaiFile([
      { name: 'training.zip', sizeKB: 1, type: 'Training Data', downloadUrl: 'x' },
      { name: 'model.pt', sizeKB: 1, type: 'Model', downloadUrl: 'x', metadata: { format: 'PickleTensor' } },
      { name: 'model.safetensors', sizeKB: 1, type: 'Model', primary: true, downloadUrl: 'x', metadata: { format: 'SafeTensor' } },
    ]);
    expect(file?.name).toBe('model.safetensors');
  });

  it('strips html descriptions', () => {
    expect(stripHtml('<p>Hello&nbsp;<b>world</b></p><p>x &amp; y</p>')).toBe('Hello world\nx & y');
  });
});

describe('huggingface helpers', () => {
  it('parses blob/resolve urls', () => {
    expect(parseHfUrl('https://huggingface.co/black-forest-labs/FLUX.1-dev/blob/main/ae.safetensors')).toEqual({
      repo: 'black-forest-labs/FLUX.1-dev',
      revision: 'main',
      path: 'ae.safetensors',
    });
    expect(parseHfUrl('https://huggingface.co/comfyanonymous/flux_text_encoders')).toEqual({
      repo: 'comfyanonymous/flux_text_encoders',
      revision: 'main',
    });
    expect(parseHfUrl('https://github.com/x/y')).toBeNull();
  });
});

describe('paths', () => {
  it('blocks path traversal', () => {
    const base = join(tmpdir(), 'models', 'loras');
    expect(safeJoin(base, 'sub/file.safetensors')).toBe(join(base, 'sub', 'file.safetensors'));
    expect(() => safeJoin(base, '../../evil')).toThrow();
    expect(() => safeJoin(base, '')).toThrow();
  });

  it('sanitizes file names', () => {
    expect(sanitizeFileName('a/b/c:d?.safetensors')).toBe('c_d_.safetensors');
    expect(sanitizeFileName('..hidden.safetensors')).toBe('hidden.safetensors');
  });

  it('detects portable and venv layouts', () => {
    const portable = mkdtempSync(join(tmpdir(), 'atelier-portable-'));
    mkdirSync(join(portable, 'ComfyUI', 'models'), { recursive: true });
    mkdirSync(join(portable, 'python_embeded'));
    writeFileSync(join(portable, 'ComfyUI', 'main.py'), '');
    writeFileSync(join(portable, 'python_embeded', 'python.exe'), '');
    const layout = detectComfyLayout(portable);
    expect(layout).toMatchObject({ root: join(portable, 'ComfyUI'), kind: 'portable', hasMainPy: true, hasModels: true });

    const venv = mkdtempSync(join(tmpdir(), 'atelier-venv-'));
    writeFileSync(join(venv, 'main.py'), '');
    const bin = process.platform === 'win32' ? join(venv, '.venv', 'Scripts') : join(venv, '.venv', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
    expect(detectComfyLayout(venv)?.kind).toBe('venv');
    expect(detectComfyLayout(join(venv, 'nope'))).toBeNull();
  });
});

describe('misc', () => {
  it('splits command-line args with quotes', () => {
    expect(splitArgs('--lowvram --output-directory "C:/My Images" --x')).toEqual(['--lowvram', '--output-directory', 'C:/My Images', '--x']);
  });
  it('redacts tokens from urls', () => {
    expect(redact('https://civitai.com/api/download/models/1?token=secret&type=Model')).toBe(
      'https://civitai.com/api/download/models/1?token=***&type=Model',
    );
  });
});
