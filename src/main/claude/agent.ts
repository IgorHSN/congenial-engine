import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { ApprovalRequest, ClaudeEvent, ClaudeItem, Settings } from '@shared/types';
import { JsonFile, newId } from '../store';
import { SETUP_SYSTEM_PROMPT } from './prompt';
import { DENIED_PREFIX, toTranscript } from './transcript';
import { TOOL_PARAMS, ToolError, toolByName, type ToolContext } from './tools';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

const MAX_ITERATIONS = 40;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/**
 * App updates can change the system prompt or tool list mid-conversation; with
 * this, thinking blocks that no longer match are dropped instead of failing.
 */
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';

interface Deps {
  dataDir: string;
  settings: () => Settings;
  apiKey: () => string | undefined;
  emit: (e: ClaudeEvent) => void;
  /** Override for tests (e.g. a client pointed at a fake server). */
  createClient?: (apiKey: string) => Anthropic;
  /** Everything a tool needs except the per-turn signal and approval hook. */
  toolContext: Omit<ToolContext, 'approve' | 'signal'>;
}

/**
 * The setup chat: a Claude agent loop with app-specific tools. The API
 * conversation is persisted verbatim and only ever appended to, so replayed
 * thinking blocks and the prompt cache stay valid.
 */
export class ClaudeAgent {
  private messages: MessageParam[] = [];
  private readonly file: JsonFile<{ messages: MessageParam[] }>;
  private controller: AbortController | null = null;
  private approvals = new Map<string, (ok: boolean) => void>();

  constructor(private readonly d: Deps) {
    this.file = new JsonFile(join(d.dataDir, 'claude-conversation.json'), () => ({ messages: [] }));
  }

  async load(): Promise<void> {
    this.messages = (await this.file.read()).messages ?? [];
    this.repairDanglingToolUse();
  }

  get busy(): boolean {
    return this.controller !== null;
  }

  transcript(): ClaudeItem[] {
    return toTranscript(this.messages);
  }

  async reset(): Promise<void> {
    this.stop();
    this.messages = [];
    await this.persist();
  }

  stop(): void {
    this.controller?.abort();
    for (const [requestId, resolve] of this.approvals) {
      resolve(false);
      this.d.emit({ type: 'approval-resolved', requestId, approved: false });
    }
    this.approvals.clear();
  }

  respondApproval(requestId: string, approved: boolean): void {
    const resolve = this.approvals.get(requestId);
    if (!resolve) return;
    this.approvals.delete(requestId);
    resolve(approved);
    this.d.emit({ type: 'approval-resolved', requestId, approved });
  }

  private persist(): Promise<void> {
    return this.file.write({ messages: this.messages });
  }

  /** If the app died mid-tool-call, close the open tool_use blocks so the history stays valid. */
  private repairDanglingToolUse(): void {
    const last = this.messages[this.messages.length - 1];
    if (!last || last.role !== 'assistant' || typeof last.content === 'string') return;
    const open = last.content.filter((b) => b.type === 'tool_use');
    if (!open.length) return;
    this.messages.push({
      role: 'user',
      content: open.map(
        (b): ToolResult => ({
          type: 'tool_result',
          tool_use_id: (b as Anthropic.Beta.BetaToolUseBlockParam).id,
          is_error: true,
          content: 'Interrupted: the app was closed before this tool finished.',
        }),
      ),
    });
  }

  async send(text: string): Promise<void> {
    if (this.controller) throw new Error('O Claude ainda está respondendo.');
    const apiKey = this.d.apiKey();
    if (!apiKey) {
      this.d.emit({ type: 'notice', level: 'error', text: 'Configure sua API key da Anthropic em Configurações → Claude.' });
      this.d.emit({ type: 'turn-end', stopReason: null });
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.messages.push({ role: 'user', content: text });
    await this.persist();
    this.d.emit({ type: 'turn-start' });

    let stopReason: string | null = null;
    try {
      stopReason = await this.loop(this.d.createClient?.(apiKey) ?? new Anthropic({ apiKey }), controller.signal);
    } catch (err) {
      this.d.emit({ type: 'notice', level: controller.signal.aborted ? 'info' : 'error', text: describeError(err, controller.signal) });
    } finally {
      this.controller = null;
      this.approvals.clear();
      await this.persist();
      this.d.emit({ type: 'turn-end', stopReason });
    }
  }

  private async loop(client: Anthropic, signal: AbortSignal): Promise<string | null> {
    let jsonRetries = 0;
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const s = this.d.settings().claude;
      let message: Anthropic.Beta.BetaMessage;
      try {
        const stream = client.beta.messages.stream(
          {
            model: s.model,
            max_tokens: 64000,
            betas: [FALLBACK_BETA, BINDING_BETA],
            fallbacks: 'default',
            system: SETUP_SYSTEM_PROMPT,
            tools: TOOL_PARAMS,
            thinking: { type: 'adaptive', display: 'summarized', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
            output_config: { effort: s.effort },
            cache_control: { type: 'ephemeral' },
            messages: this.messages,
          },
          { signal },
        );
        for await (const event of stream) {
          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            this.d.emit({ type: 'tool-start', id: event.content_block.id, name: event.content_block.name });
          } else if (event.type === 'content_block_delta') {
            const blockKey = `${iteration}-${event.index}`;
            if (event.delta.type === 'text_delta') this.d.emit({ type: 'text-delta', blockKey, text: event.delta.text });
            else if (event.delta.type === 'thinking_delta') {
              this.d.emit({ type: 'thinking-delta', blockKey, text: event.delta.thinking });
            }
          }
        }
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // With eager input streaming the SDK rejects when a tool input is not
        // parseable JSON. Only that case is retried; API errors propagate.
        if (err instanceof Anthropic.APIError || signal.aborted || jsonRetries++ >= 2) throw err;
        this.d.emit({ type: 'notice', level: 'warning', text: 'Entrada de ferramenta malformada; repetindo o turno…' });
        continue;
      }

      this.messages.push({ role: 'assistant', content: message.content });
      await this.persist();

      if (message.stop_reason === 'refusal') {
        this.d.emit({
          type: 'notice',
          level: 'warning',
          text: `O Claude recusou este pedido${message.stop_details?.category ? ` (${message.stop_details.category})` : ''}.`,
        });
        return 'refusal';
      }
      if (message.stop_reason === 'pause_turn') continue;

      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (toolUses.length === 0) return message.stop_reason;

      const truncated = message.stop_reason === 'max_tokens';
      const results = await Promise.all(toolUses.map((tu) => this.runTool(tu, signal, truncated)));
      this.messages.push({ role: 'user', content: results });
      await this.persist();
      if (signal.aborted) return 'aborted';
    }
    this.d.emit({ type: 'notice', level: 'warning', text: 'Limite de passos atingido neste turno. Envie "continue" para seguir.' });
    return 'max_iterations';
  }

  private async runTool(tu: Anthropic.Beta.BetaToolUseBlock, signal: AbortSignal, truncated: boolean): Promise<ToolResult> {
    const fail = (content: string): ToolResult => {
      this.d.emit({ type: 'tool-result', id: tu.id, ok: false, summary: content.slice(0, 300) });
      return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content };
    };
    if (truncated) return fail('Tool input was cut off (max_tokens). Retry with a smaller input.');
    if (signal.aborted) return fail('Cancelled by the user.');

    const def = toolByName(tu.name);
    if (!def) return fail(`Unknown tool ${tu.name}.`);
    // Eager input streaming skips server-side validation: validate before running.
    const parsed = def.schema.safeParse(tu.input);
    if (!parsed.success) {
      return fail(JSON.stringify({ INVALID_INPUT: parsed.error.issues.slice(0, 5), received: tu.input }).slice(0, 4000));
    }
    this.d.emit({ type: 'tool-running', id: tu.id, name: tu.name, input: parsed.data });

    const ctx: ToolContext = {
      ...this.d.toolContext,
      signal,
      approve: (req) => this.requestApproval(tu.id, req, signal),
    };
    try {
      const output = await (def.run as (i: unknown, c: ToolContext) => Promise<unknown>)(parsed.data, ctx);
      const content = output as ToolResult['content'];
      const text = typeof content === 'string' ? content : '[resultado com imagem]';
      const denied = typeof content === 'string' && content.startsWith(DENIED_PREFIX);
      this.d.emit({ type: 'tool-result', id: tu.id, ok: !denied, summary: text.slice(0, 300) });
      return { type: 'tool_result', tool_use_id: tu.id, content, ...(denied ? { is_error: true } : {}) };
    } catch (err) {
      const msg = err instanceof ToolError ? err.message : `Error: ${(err as Error).message}`;
      return fail(signal.aborted ? 'Cancelled by the user.' : msg);
    }
  }

  private requestApproval(
    toolUseId: string,
    req: Omit<ApprovalRequest, 'requestId' | 'toolUseId'>,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const requestId = newId('ap-');
    return new Promise<boolean>((resolve) => {
      this.approvals.set(requestId, resolve);
      this.d.emit({ type: 'approval', request: { ...req, requestId, toolUseId } });
    });
  }
}

function describeError(err: unknown, signal: AbortSignal): string {
  if (signal.aborted) return 'Interrompido.';
  if (err instanceof Anthropic.AuthenticationError) return 'API key da Anthropic inválida. Verifique em Configurações → Claude.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Sua API key não tem permissão para este modelo.';
  if (err instanceof Anthropic.NotFoundError) return 'Modelo não encontrado. Verifique o modelo em Configurações → Claude.';
  if (err instanceof Anthropic.RateLimitError) return 'Limite de uso da API atingido. Tente novamente em instantes.';
  if (err instanceof Anthropic.BadRequestError) return `Requisição inválida: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return 'Sem conexão com a API da Anthropic.';
  if (err instanceof Anthropic.APIError) return `Erro da API (${err.status ?? '?'}): ${err.message}`;
  return (err as Error)?.message ?? String(err);
}
