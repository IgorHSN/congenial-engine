import { join } from 'node:path';
import { BASE_MODEL_PROFILES } from '@shared/presets';
import type { BaseModel, Pipeline, Workspace } from '@shared/types';
import { JsonFile, newId } from './store';

export type WorkspaceInput = Partial<Omit<Workspace, 'createdAt' | 'updatedAt'>> & {
  name: string;
  baseModel: BaseModel;
};

/** CRUD for workspaces (generation presets). */
export class WorkspaceStore {
  private items: Workspace[] = [];
  private readonly file: JsonFile<Workspace[]>;
  private listeners = new Set<(items: Workspace[]) => void>();

  constructor(dataDir: string) {
    this.file = new JsonFile(join(dataDir, 'workspaces.json'), () => []);
  }

  async load(): Promise<void> {
    this.items = await this.file.read();
  }

  list(): Workspace[] {
    return this.items.map((w) => ({ ...w }));
  }

  get(id: string): Workspace | undefined {
    return this.items.find((w) => w.id === id);
  }

  onChange(l: (items: Workspace[]) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private async persist(): Promise<void> {
    await this.file.write(this.items);
    for (const l of this.listeners) l(this.list());
  }

  /** Create (no id / unknown id) or update (existing id) a workspace, filling sensible defaults. */
  async save(input: WorkspaceInput): Promise<Workspace> {
    const existing = input.id ? this.get(input.id) : undefined;
    const profile = BASE_MODEL_PROFILES[input.baseModel] ?? BASE_MODEL_PROFILES.other;
    const now = new Date().toISOString();
    const pipeline: Pipeline = input.pipeline ?? existing?.pipeline ?? (input.unet ? 'flux' : 'checkpoint');

    const ws: Workspace = {
      id: existing?.id ?? input.id ?? newId('ws-'),
      name: input.name,
      description: input.description ?? existing?.description ?? '',
      baseModel: input.baseModel,
      pipeline,
      checkpoint: input.checkpoint ?? existing?.checkpoint,
      unet: input.unet ?? existing?.unet,
      clip1: input.clip1 ?? existing?.clip1,
      clip2: input.clip2 ?? existing?.clip2,
      vae: input.vae ?? existing?.vae,
      loras: input.loras ?? existing?.loras ?? [],
      optionalLoras: input.optionalLoras ?? existing?.optionalLoras ?? [],
      defaults: { ...profile.defaults, ...(existing?.defaults ?? {}), ...(input.defaults ?? {}) },
      positivePrefix: input.positivePrefix ?? existing?.positivePrefix ?? profile.positivePrefix,
      negativePrompt: input.negativePrompt ?? existing?.negativePrompt ?? profile.negativePrompt,
      refinerNotes: input.refinerNotes ?? existing?.refinerNotes ?? '',
      customWorkflow: input.customWorkflow ?? existing?.customWorkflow,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    validateWorkspace(ws);

    if (existing) this.items = this.items.map((w) => (w.id === ws.id ? ws : w));
    else this.items.push(ws);
    await this.persist();
    return ws;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.items.length;
    this.items = this.items.filter((w) => w.id !== id);
    if (this.items.length === before) return false;
    await this.persist();
    return true;
  }
}

export function validateWorkspace(ws: Workspace): void {
  if (!ws.name.trim()) throw new Error('O workspace precisa de um nome.');
  if (ws.pipeline === 'checkpoint' && !ws.checkpoint) {
    throw new Error('Pipeline "checkpoint" precisa do campo checkpoint (arquivo em models/checkpoints).');
  }
  if (ws.pipeline === 'flux' && (!ws.unet || !ws.clip1 || !ws.clip2 || !ws.vae)) {
    throw new Error('Pipeline "flux" precisa de unet, clip1, clip2 e vae.');
  }
  if (ws.pipeline === 'custom' && (!ws.customWorkflow || typeof ws.customWorkflow !== 'object')) {
    throw new Error('Pipeline "custom" precisa de customWorkflow (JSON no formato API do ComfyUI).');
  }
  for (const l of [...ws.loras, ...ws.optionalLoras]) {
    if (!l.file) throw new Error('Toda LoRA precisa do campo file.');
    if (!Number.isFinite(l.strength) || Math.abs(l.strength) > 4) throw new Error(`Força inválida para ${l.file}.`);
  }
  const d = ws.defaults;
  if (d.width % 8 !== 0 || d.height % 8 !== 0) throw new Error('Largura e altura precisam ser múltiplos de 8.');
  if (d.width < 64 || d.height < 64 || d.width > 4096 || d.height > 4096) throw new Error('Resolução fora do intervalo 64–4096.');
  if (d.steps < 1 || d.steps > 150) throw new Error('steps deve estar entre 1 e 150.');
  if (d.batchSize < 1 || d.batchSize > 16) throw new Error('batchSize deve estar entre 1 e 16.');
}
