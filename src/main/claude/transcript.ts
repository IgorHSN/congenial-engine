import type Anthropic from '@anthropic-ai/sdk';
import type { ClaudeItem, ToolCallView } from '@shared/types';

export const DENIED_PREFIX = 'USER_DENIED';

function resultText(content: Anthropic.Beta.BetaToolResultBlockParam['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[imagem]' : ''))
    .filter(Boolean)
    .join('\n');
}

/** Turn the API conversation (source of truth) into display items for the UI. */
export function toTranscript(messages: Anthropic.Beta.BetaMessageParam[]): ClaudeItem[] {
  const items: ClaudeItem[] = [];
  const tools = new Map<string, ToolCallView>();

  messages.forEach((msg, mi) => {
    if (typeof msg.content === 'string') {
      if (msg.role === 'user') items.push({ kind: 'user', id: `m${mi}`, text: msg.content });
      else items.push({ kind: 'assistant-text', id: `m${mi}`, text: msg.content });
      return;
    }
    (msg.content ?? []).forEach((block, bi) => {
      const id = `m${mi}b${bi}`;
      switch (block.type) {
        case 'text':
          if (!block.text.trim()) break;
          items.push(msg.role === 'user' ? { kind: 'user', id, text: block.text } : { kind: 'assistant-text', id, text: block.text });
          break;
        case 'thinking':
          if (block.thinking.trim()) items.push({ kind: 'thinking', id, text: block.thinking });
          break;
        case 'tool_use': {
          const call: ToolCallView = { id: block.id, name: block.name, input: block.input, status: 'error', result: 'Sem resultado.' };
          tools.set(block.id, call);
          items.push({ kind: 'tool', id, call });
          break;
        }
        case 'tool_result': {
          const call = tools.get(block.tool_use_id);
          if (!call) break;
          const text = resultText(block.content);
          call.result = text;
          call.status = text.startsWith(DENIED_PREFIX) ? 'denied' : block.is_error ? 'error' : 'done';
          break;
        }
        case 'fallback':
          items.push({
            kind: 'notice',
            id,
            level: 'info',
            text: `${block.from.model} recusou este turno; ${block.to.model} continuou a resposta.`,
          });
          break;
        default:
          break;
      }
    });
  });
  return items;
}
