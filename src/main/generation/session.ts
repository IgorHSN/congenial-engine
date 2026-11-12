import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { BASE_MODEL_PROFILES, SAFETY_NEGATIVE, sizeFor } from '@shared/presets';
import type { GenEntry, GenEvent, GenSendOptions, GenerationJob, RefinedPrompt, Settings, Workspace } from '@shared/types';
import type { ComfyClient } from '../comfy/client';
import type { ModelInventory } from '../comfy/inventory';
import { buildWorkflow, randomSeed } from '../comfy/workflow';
import { JsonFile, newId } from '../store';
import type { WorkspaceStore } from '../workspaces';
import type { LocalLlm } from './llm';
import {
  REFINED_SCHEMA,
  RefinerParseError,
  buildRefinerMessages,
  buildRefinerSystemPrompt,
  joinPrompt,
  loraContext,
  parseRefined,
  type HistoryTurn,
} from './refiner';
import { checkSafety, isSexual } from './safety';

interface Deps {
  dataDir: string;
  settings: () => Settings;
  comfy: ComfyClient;
  llm: LocalLlm;
  inventory: ModelInventory;
  workspaces: WorkspaceStore;
  emit: (e: GenEvent) => void;
}

/**
 * The generation chat: natural language → local LLM → refined prompt →
 * ComfyUI workflow → images. Runs entirely on the user's machine.
 */
export class GenerationSession {
  private entries: GenEntry[] = [];
  private readonly file: JsonFile<GenEntry[]>;
  private controller: AbortController | null = null;
  private busy = false;

  constructor(private readonly d: Deps) {
    this.file = new JsonFile(join(d.dataDir, 'generation-history.json'), () => []);
  }

  async load(): Promise<void> {
    this.entries = await this.file.read();
    // Jobs interrupted by an app restart.
    for (const e of this.entries) {
      if (e.kind === 'result' && (e.job.status === 'queued' || e.job.status === 'running')) {
        e.job.status = 'cancelled';
      }
    }
  }

  history(): GenEntry[] {
    return this.entries;
  }

  async reset(): Promise<void> {
    this.stop();
    this.entries = [];
    await this.file.write(this.entries);
  }

  stop(): void {
    this.controller?.abort();
  }

  private setBusy(busy: boolean, stage?: 'refining' | 'queueing' | 'generating'): void {
    this.busy = busy;
    this.d.emit({ type: 'busy', busy, stage });
  }

  private push(entry: GenEntry): void {
    this.entries.push(entry);
    this.d.emit({ type: 'entry', entry });
    void this.file.write(this.entries);
  }

  private update(entry: GenEntry, persist = true): void {
    this.d.emit({ type: 'entry-update', entry });
    if (persist) void this.file.write(this.entries);
  }

  private notice(level: 'info' | 'warning' | 'error', text: string): void {
    this.push({ kind: 'notice', id: newId('n-'), at: new Date().toISOString(), level, text });
  }

  private resolveWorkspace(id?: string): Workspace | null {
    const wsId = id ?? this.d.settings().generation.activeWorkspaceId;
    if (wsId) {
      const ws = this.d.workspaces.get(wsId);
      if (ws) return ws;
    }
    return this.d.workspaces.list()[0] ?? null;
  }

  async send(text: string, opts: GenSendOptions = {}): Promise<void> {
    if (this.busy) {
      this.notice('warning', 'Aguarde a geração atual terminar (ou clique em Parar).');
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;

    // Slash commands: "/raw <prompt>" sends the text as-is.
    let raw = !!opts.raw;
    let userText = trimmed;
    if (/^\/raw\s+/i.test(userText)) {
      raw = true;
      userText = userText.replace(/^\/raw\s+/i, '');
    }

    this.push({ kind: 'user', id: newId('u-'), text: trimmed, at: new Date().toISOString() });
    const ws = this.resolveWorkspace(opts.workspaceId);
    if (!ws) {
      this.notice(
        'warning',
        'Nenhum workspace configurado. Peça ao chat de configuração (Claude) para criar um, por exemplo: "crie um workspace com o checkpoint X".',
      );
      return;
    }

    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.setBusy(true, raw ? 'queueing' : 'refining');
    try {
      let refined: RefinedPrompt;
      if (raw) {
        refined = { positive: userText, negative: '', loras: [], comment: 'Prompt enviado sem refinamento.' };
      } else {
        const result = await this.refine(ws, userText, signal);
        if (result.refused) {
          this.notice('warning', result.reason);
          return;
        }
        refined = result.prompt;
      }
      await this.generate(ws, userText, refined, signal);
    } catch (err) {
      if (signal.aborted) this.notice('info', 'Cancelado.');
      else this.notice('error', (err as Error).message);
    } finally {
      this.controller = null;
      this.setBusy(false);
    }
  }

  /** Re-run a previous result with a new seed (or the same seed). */
  async rerun(entryId: string, newSeed = true): Promise<void> {
    if (this.busy) return;
    const prev = this.entries.find((e) => e.id === entryId);
    if (!prev || prev.kind !== 'result') return;
    const ws = this.d.workspaces.get(prev.workspaceId) ?? this.resolveWorkspace();
    if (!ws) {
      this.notice('warning', 'O workspace desse resultado não existe mais.');
      return;
    }
    this.controller = new AbortController();
    this.setBusy(true, 'queueing');
    try {
      const refined: RefinedPrompt = { ...prev.refined, seed: newSeed ? undefined : prev.job.seed };
      await this.generate(ws, '', refined, this.controller.signal, prev);
    } catch (err) {
      if (this.controller?.signal.aborted) this.notice('info', 'Cancelado.');
      else this.notice('error', (err as Error).message);
    } finally {
      this.controller = null;
      this.setBusy(false);
    }
  }

  private async refine(ws: Workspace, userText: string, signal: AbortSignal) {
    const inventory = await this.d.inventory.list('loras').catch(() => []);
    const system = buildRefinerSystemPrompt({
      workspace: ws,
      fixedLoras: loraContext(ws.loras, inventory),
      optionalLoras: loraContext(ws.optionalLoras, inventory),
    });
    const turns: HistoryTurn[] = [];
    let pendingUser: string | null = null;
    for (const e of this.entries.slice(0, -1)) {
      if (e.kind === 'user') pendingUser = e.text;
      else if (e.kind === 'result' && pendingUser !== null) {
        turns.push({ user: pendingUser, refined: e.refined });
        pendingUser = null;
      }
    }
    const messages = buildRefinerMessages(system, turns, userText);

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await this.d.llm.chatJson(messages, REFINED_SCHEMA as unknown as Record<string, unknown>, signal);
      try {
        return parseRefined(raw, ws.optionalLoras);
      } catch (err) {
        if (!(err instanceof RefinerParseError)) throw err;
        lastErr = err;
      }
    }
    throw lastErr ?? new Error('Falha ao refinar o prompt.');
  }

  private async generate(
    ws: Workspace,
    userText: string,
    refined: RefinedPrompt,
    signal: AbortSignal,
    basedOn?: Extract<GenEntry, { kind: 'result' }>,
  ): Promise<void> {
    const profile = BASE_MODEL_PROFILES[ws.baseModel] ?? BASE_MODEL_PROFILES.other;
    const d = ws.defaults;

    const loras = [...ws.loras, ...(refined.loras ?? [])];
    // Make sure single-trigger optional LoRAs get their trigger word.
    const inventory = await this.d.inventory.list('loras').catch(() => []);
    const extraTriggers: string[] = [];
    for (const l of refined.loras ?? []) {
      const tw = inventory.find((m) => m.file === l.file)?.meta.triggerWords;
      if (tw?.length === 1 && !refined.positive.toLowerCase().includes(tw[0].toLowerCase())) extraTriggers.push(tw[0]);
    }

    const finalPositive = joinPrompt(ws.positivePrefix, ...extraTriggers, refined.positive);
    const sexual = isSexual(`${userText} ${finalPositive}`);
    const finalNegative = profile.usesNegative
      ? joinPrompt(ws.negativePrompt, refined.negative, sexual ? SAFETY_NEGATIVE : '')
      : '';

    const verdict = checkSafety(userText, finalPositive);
    if (!verdict.allowed) {
      this.notice('warning', verdict.reason!);
      return;
    }

    const size =
      refined.width && refined.height
        ? { width: refined.width, height: refined.height }
        : refined.aspect
          ? scaleToWorkspace(sizeFor(ws.baseModel, refined.aspect), d.width, d.height)
          : { width: d.width, height: d.height };
    const seed = refined.seed ?? randomSeed();

    const job: GenerationJob = {
      promptId: null,
      status: 'queued',
      progress: 0,
      images: [],
      seed,
      width: size.width,
      height: size.height,
    };
    const entry: Extract<GenEntry, { kind: 'result' }> = {
      kind: 'result',
      id: newId('r-'),
      at: new Date().toISOString(),
      workspaceId: ws.id,
      workspaceName: ws.name,
      refined: basedOn ? { ...basedOn.refined, seed: refined.seed } : refined,
      finalPositive,
      finalNegative,
      job,
    };
    this.push(entry);
    this.setBusy(true, 'queueing');

    const graph = buildWorkflow(ws, {
      positive: finalPositive,
      negative: finalNegative,
      width: size.width,
      height: size.height,
      steps: refined.steps ?? d.steps,
      cfg: refined.cfg ?? d.cfg,
      seed,
      batchSize: refined.batchSize ?? d.batchSize,
      sampler: d.sampler,
      scheduler: d.scheduler,
      guidance: d.guidance,
      clipSkip: d.clipSkip,
      loras,
    });

    try {
      const result = await this.d.comfy.run(graph, {
        signal,
        onQueued: (promptId) => {
          job.promptId = promptId;
          job.status = 'running';
          this.setBusy(true, 'generating');
          this.update(entry);
        },
        onProgress: ({ value, max }) => {
          job.progress = max > 0 ? value / max : 0;
          this.update(entry, false);
        },
      });
      const dir = join(this.d.settings().generation.outputDir, new Date().toISOString().slice(0, 10));
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
      for (const [i, ref] of result.images.entries()) {
        const buf = await this.d.comfy.fetchImage(ref);
        const ext = ref.filename.toLowerCase().endsWith('.webp') ? 'webp' : 'png';
        const path = join(dir, `${stamp}_${seed}_${i + 1}.${ext}`);
        await fs.writeFile(path, buf);
        job.images.push(path);
      }
      job.status = 'done';
      job.progress = 1;
      if (!result.images.length) job.error = 'O workflow terminou sem gerar imagens (há um nó SaveImage?).';
    } catch (err) {
      job.status = signal.aborted ? 'cancelled' : 'error';
      job.error = (err as Error).message;
    }
    this.update(entry);
  }
}

/** Keep the aspect ratio requested but respect the workspace's pixel budget (e.g. SD1.5 at 512px). */
function scaleToWorkspace(
  target: { width: number; height: number },
  defW: number,
  defH: number,
): { width: number; height: number } {
  const budget = defW * defH;
  const ratio = target.width / target.height;
  const h = Math.sqrt(budget / ratio);
  const w = h * ratio;
  const round = (n: number) => Math.max(64, Math.round(n / 64) * 64);
  return { width: round(w), height: round(h) };
}
