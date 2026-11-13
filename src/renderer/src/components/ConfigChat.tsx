import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, ClaudeEvent, ClaudeItem, PublicSettings, ToolCallView } from '@shared/types';
import { api, imageUrl } from '../api';
import { Markdown } from './Markdown';

const TOOL_LABELS: Record<string, string> = {
  comfy_status: 'Verificando o ComfyUI',
  list_models: 'Listando modelos instalados',
  search_civitai: 'Buscando na Civitai',
  get_civitai_model: 'Lendo modelo da Civitai',
  search_huggingface: 'Buscando no Hugging Face',
  list_huggingface_files: 'Listando arquivos do Hugging Face',
  download_model: 'Baixando modelo',
  delete_model: 'Apagando modelo',
  update_model_metadata: 'Atualizando metadados',
  identify_local_models: 'Identificando modelos locais',
  list_comfy_workflows: 'Listando workflows do ComfyUI',
  read_comfy_workflow: 'Lendo workflow',
  list_custom_nodes: 'Listando custom nodes',
  install_custom_node: 'Instalando custom node',
  run_command: 'Executando comando',
  comfy_node_info: 'Consultando nós do ComfyUI',
  restart_comfyui: 'Reiniciando o ComfyUI',
  list_workspaces: 'Listando workspaces',
  save_workspace: 'Salvando workspace',
  delete_workspace: 'Apagando workspace',
  test_workspace: 'Testando workspace',
};

const SUGGESTIONS = [
  'Verifique minha instalação do ComfyUI e me diga o que falta.',
  'Identifique as LoRAs que eu já tenho e importe meus workflows salvos como workspaces.',
  'Instale um bom checkpoint realista SDXL para a minha GPU e crie um workspace.',
  'Quero gerar no estilo anime: instale o Illustrious XL e uma LoRA de aquarela.',
  'Configure o Flux dev em fp8 com tudo que precisa.',
];

interface Props {
  settings: PublicSettings;
  onOpenSettings: () => void;
}

export function ConfigChat({ settings, onOpenSettings }: Props) {
  const [items, setItems] = useState<ClaudeItem[]>([]);
  const [live, setLive] = useState<ClaudeItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    const t = await api.claude.transcript();
    setItems(t.items);
    setBusy(t.busy);
  }, []);

  useEffect(() => {
    void reload();
    return api.claude.onEvent((e: ClaudeEvent) => {
      switch (e.type) {
        case 'turn-start':
          setBusy(true);
          setLive([]);
          void reload().then(() => setBusy(true));
          break;
        case 'text-delta':
        case 'thinking-delta': {
          const kind = e.type === 'text-delta' ? 'assistant-text' : 'thinking';
          setLive((prev) => {
            const idx = prev.findIndex((i) => i.id === e.blockKey);
            if (idx === -1) return [...prev, { kind, id: e.blockKey, text: e.text } as ClaudeItem];
            const copy = prev.slice();
            const it = copy[idx] as Extract<ClaudeItem, { text: string }>;
            copy[idx] = { ...it, text: it.text + e.text };
            return copy;
          });
          break;
        }
        case 'tool-start':
          setLive((prev) => [
            ...prev,
            { kind: 'tool', id: `t-${e.id}`, call: { id: e.id, name: e.name, input: null, status: 'running' } },
          ]);
          break;
        case 'tool-running':
          setLive((prev) => updateTool(prev, e.id, (c) => ({ ...c, input: e.input, status: 'running' })));
          break;
        case 'tool-result':
          setLive((prev) =>
            updateTool(prev, e.id, (c) => ({
              ...c,
              status: e.ok ? 'done' : e.summary.startsWith('USER_DENIED') ? 'denied' : 'error',
              result: e.summary,
            })),
          );
          setApprovals((prev) => prev.filter((a) => a.toolUseId !== e.id));
          break;
        case 'approval':
          setApprovals((prev) => [...prev, e.request]);
          setLive((prev) => updateTool(prev, e.request.toolUseId, (c) => ({ ...c, status: 'awaiting-approval' })));
          break;
        case 'approval-resolved':
          setApprovals((prev) => prev.filter((a) => a.requestId !== e.requestId));
          break;
        case 'notice':
          setLive((prev) => [...prev, { kind: 'notice', id: `n-${Date.now()}-${Math.random()}`, level: e.level, text: e.text }]);
          break;
        case 'turn-end':
          void reload().then(() => {
            // Keep notices from this turn visible; the rest is now in the transcript.
            setLive((prev) => prev.filter((i) => i.kind === 'notice'));
            setApprovals([]);
            setBusy(false);
          });
          break;
      }
    });
  }, [reload]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, live, approvals]);

  const submit = async (text?: string) => {
    const t = (text ?? input).trim();
    if (!t || busy) return;
    setInput('');
    setLive([{ kind: 'user', id: `pending-${Date.now()}`, text: t }]);
    setBusy(true);
    await api.claude.send(t);
  };

  const reset = async () => {
    if (!confirm('Começar uma nova conversa de configuração? O histórico atual será apagado.')) return;
    await api.claude.reset();
    setLive([]);
    await reload();
  };

  const noKey = !settings.secrets.anthropicApiKey;
  const all = [...items, ...live];

  return (
    <div className="chat">
      <div className="chat-header">
        <div>
          <h2>Configuração</h2>
          <div className="muted small">Claude · instala modelos, LoRAs, nós e monta workspaces</div>
        </div>
        <div className="spacer" />
        <span className="chip small">{settings.claude.model}</span>
        <button className="btn ghost small" onClick={() => void reset()} disabled={busy}>
          Nova conversa
        </button>
      </div>

      <div className="chat-body" ref={scrollRef}>
        {noKey && (
          <div className="callout">
            <p style={{ margin: '0 0 8px' }}>
              Este chat usa a API da Anthropic (pago por uso). Sem API key, você pode:
            </p>
            <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
              <li>
                usar o <strong>Claude Desktop / Claude Code</strong> com a sua assinatura — Configurações → Claude Desktop/Code;
              </li>
              <li>
                criar workspaces <strong>manualmente</strong> no botão <strong>+</strong> do chat de geração.
              </li>
            </ul>
            <button className="btn small" onClick={onOpenSettings}>
              Abrir configurações
            </button>
          </div>
        )}
        {all.length === 0 && !noKey && (
          <div className="empty">
            <p>Peça qualquer coisa sobre a sua instalação do ComfyUI:</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => void submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {all.map((item) => (
          <ItemView key={item.id} item={item} />
        ))}
        {approvals.map((a) => (
          <div key={a.requestId} className={`approval ${a.danger}`}>
            <div className="approval-title">{a.title}</div>
            <pre className="approval-details">{a.details}</pre>
            <div className="approval-actions">
              <button className="btn primary" onClick={() => void api.claude.approve(a.requestId, true)}>
                Aprovar
              </button>
              <button className="btn ghost" onClick={() => void api.claude.approve(a.requestId, false)}>
                Negar
              </button>
            </div>
          </div>
        ))}
        {busy && approvals.length === 0 && <div className="typing">Claude está trabalhando…</div>}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          value={input}
          placeholder={noKey ? 'Configure a API key primeiro' : 'Ex.: instale a LoRA https://civitai.com/models/… e adicione ao workspace'}
          disabled={noKey}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
        />
        {busy ? (
          <button type="button" className="btn danger" onClick={() => void api.claude.stop()}>
            Parar
          </button>
        ) : (
          <button type="submit" className="btn primary" disabled={!input.trim() || noKey}>
            Enviar
          </button>
        )}
      </form>
    </div>
  );
}

function updateTool(items: ClaudeItem[], id: string, fn: (c: ToolCallView) => ToolCallView): ClaudeItem[] {
  return items.map((i) => (i.kind === 'tool' && i.call.id === id ? { ...i, call: fn(i.call) } : i));
}

function ItemView({ item }: { item: ClaudeItem }) {
  switch (item.kind) {
    case 'user':
      return <div className="msg user">{item.text}</div>;
    case 'assistant-text':
      return (
        <div className="msg assistant">
          <Markdown text={item.text} />
        </div>
      );
    case 'thinking':
      return (
        <details className="thinking">
          <summary>Raciocínio</summary>
          <div className="small">{item.text}</div>
        </details>
      );
    case 'notice':
      return <div className={`notice ${item.level}`}>{item.text}</div>;
    case 'tool':
      return <ToolView call={item.call} />;
  }
}

function ToolView({ call }: { call: ToolCallView }) {
  const label = TOOL_LABELS[call.name] ?? call.name;
  const images = call.name === 'test_workspace' ? extractImages(call.result) : [];
  const statusLabel = {
    running: '…',
    'awaiting-approval': 'aguardando aprovação',
    done: '✓',
    error: 'erro',
    denied: 'negado',
  }[call.status];
  return (
    <details className={`tool ${call.status}`}>
      <summary>
        <span className="tool-name">{label}</span>
        <span className="tool-detail">{toolHint(call)}</span>
        <span className="tool-status">{statusLabel}</span>
      </summary>
      {call.input != null && <pre className="tool-io">{JSON.stringify(call.input, null, 2)}</pre>}
      {call.result && <pre className="tool-io result">{call.result.slice(0, 4000)}</pre>}
      {images.length > 0 && (
        <div className="tool-images">
          {images.map((p) => (
            <img key={p} src={imageUrl(p)} alt="teste" onClick={() => void api.shell.showItem(p)} />
          ))}
        </div>
      )}
    </details>
  );
}

function toolHint(call: ToolCallView): string {
  const i = (call.input ?? {}) as Record<string, unknown>;
  const v = i.query ?? i.name ?? i.ref ?? i.files ?? i.repo ?? i.git_url ?? i.command ?? i.file ?? i.hf_path ?? i.civitai_version_id ?? i.folder;
  return v == null ? '' : String(v).slice(0, 80);
}

function extractImages(result?: string): string[] {
  if (!result) return [];
  try {
    const parsed = JSON.parse(result.split('\n[imagem]')[0]) as { images?: string[] };
    return parsed.images ?? [];
  } catch {
    return [];
  }
}
