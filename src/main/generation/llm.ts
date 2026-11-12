import type { Settings } from '@shared/types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Client for the local LLM used by the generation chat. Supports Ollama's
 * native API and any OpenAI-compatible server (LM Studio, llama.cpp,
 * KoboldCpp, vLLM, text-generation-webui...). Nothing here talks to Claude.
 */
export class LocalLlm {
  constructor(private readonly getSettings: () => Settings['localLlm']) {}

  private base(): string {
    return this.getSettings().baseUrl.replace(/\/+$/, '');
  }

  private openAiBase(): string {
    const b = this.base();
    return b.endsWith('/v1') ? b : `${b}/v1`;
  }

  async listModels(): Promise<string[]> {
    const s = this.getSettings();
    if (s.provider === 'ollama') {
      const res = await fetch(`${this.base()}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`Ollama respondeu HTTP ${res.status}`);
      const body = (await res.json()) as { models?: Array<{ name: string }> };
      return (body.models ?? []).map((m) => m.name);
    }
    const res = await fetch(`${this.openAiBase()}/models`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Servidor respondeu HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((m) => m.id);
  }

  /** Chat completion that should return a JSON object matching `schema`. */
  async chatJson(messages: ChatMessage[], schema: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const s = this.getSettings();
    if (!s.model) throw new Error('Escolha o modelo do LLM local nas configurações.');
    const timeout = AbortSignal.timeout(5 * 60 * 1000);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;

    if (s.provider === 'ollama') {
      const res = await fetch(`${this.base()}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: sig,
        body: JSON.stringify({
          model: s.model,
          messages,
          stream: false,
          format: schema,
          keep_alive: parseKeepAlive(s.keepAlive),
          options: { temperature: s.temperature },
        }),
      });
      if (!res.ok) throw new Error(`Ollama respondeu HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { message?: { content?: string } };
      return stripThinking(body.message?.content ?? '');
    }

    const send = async (withFormat: boolean) =>
      fetch(`${this.openAiBase()}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: sig,
        body: JSON.stringify({
          model: s.model,
          messages,
          temperature: s.temperature,
          stream: false,
          ...(withFormat
            ? { response_format: { type: 'json_schema', json_schema: { name: 'refined_prompt', schema, strict: false } } }
            : {}),
        }),
      });
    let res = await send(true);
    // Some servers reject response_format: retry without it (the prompt still asks for JSON).
    if (res.status === 400 || res.status === 422) res = await send(false);
    if (!res.ok) throw new Error(`Servidor do LLM respondeu HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return stripThinking(body.choices?.[0]?.message?.content ?? '');
  }
}

function parseKeepAlive(v: string): string | number {
  const t = v.trim();
  if (/^-?\d+$/.test(t)) return Number(t);
  return t || '5m';
}

/** Reasoning models (Qwen3, DeepSeek-R1...) may wrap their reasoning in <think> tags. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}
