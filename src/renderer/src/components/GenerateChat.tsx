import { useEffect, useRef, useState } from 'react';
import type { GenEntry, GenEvent, PublicSettings, Workspace } from '@shared/types';
import { BASE_MODEL_PROFILES } from '@shared/presets';
import { api, imageUrl } from '../api';

interface Props {
  settings: PublicSettings;
  workspaces: Workspace[];
  onOpenSettings: () => void;
}

const STAGE_LABEL = {
  refining: 'Refinando o prompt no LLM local…',
  queueing: 'Enviando para o ComfyUI…',
  generating: 'Gerando…',
} as const;

export function GenerateChat({ settings, workspaces, onOpenSettings }: Props) {
  const [entries, setEntries] = useState<GenEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<keyof typeof STAGE_LABEL | undefined>();
  const [input, setInput] = useState('');
  const [raw, setRaw] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.gen.history().then(setEntries);
    return api.gen.onEvent((e: GenEvent) => {
      if (e.type === 'busy') {
        setBusy(e.busy);
        setStage(e.stage);
      } else if (e.type === 'entry') {
        setEntries((prev) => [...prev, e.entry]);
      } else if (e.type === 'entry-update') {
        setEntries((prev) => prev.map((x) => (x.id === e.entry.id ? e.entry : x)));
      }
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, busy]);

  const activeId = settings.generation.activeWorkspaceId ?? workspaces[0]?.id ?? '';
  const active = workspaces.find((w) => w.id === activeId);
  const llmReady = !!settings.localLlm.model;

  const submit = async () => {
    const t = input.trim();
    if (!t || busy) return;
    setInput('');
    await api.gen.send(t, { raw, workspaceId: activeId || undefined });
  };

  const clear = async () => {
    if (!confirm('Limpar o histórico deste chat? As imagens continuam salvas na pasta de saída.')) return;
    await api.gen.reset();
    setEntries([]);
  };

  return (
    <div className="chat">
      <div className="chat-header">
        <div>
          <h2>Geração</h2>
          <div className="muted small">
            LLM local{settings.localLlm.model ? ` · ${settings.localLlm.model}` : ''} · roda só no seu computador
          </div>
        </div>
        <div className="spacer" />
        <select
          className="select"
          value={activeId}
          onChange={(e) => void api.workspaces.setActive(e.target.value)}
          disabled={!workspaces.length}
          title="Workspace ativo"
        >
          {!workspaces.length && <option value="">Sem workspaces</option>}
          {workspaces.map((w) => (
            <option key={w.id} value={w.id} title={BASE_MODEL_PROFILES[w.baseModel]?.label ?? w.baseModel}>
              {w.name}
            </option>
          ))}
        </select>
        <button className="btn ghost small" onClick={() => void api.shell.openPath(settings.generation.outputDir)}>
          Pasta
        </button>
        <button className="btn ghost small" onClick={() => void clear()} disabled={busy}>
          Limpar
        </button>
      </div>

      <div className="chat-body" ref={scrollRef}>
        {!llmReady && (
          <div className="callout">
            Escolha o servidor e o modelo do LLM local (Ollama, LM Studio…) nas configurações.{' '}
            <button className="btn small" onClick={onOpenSettings}>
              Configurar
            </button>
          </div>
        )}
        {!workspaces.length && (
          <div className="callout subtle">
            Nenhum workspace ainda. Peça ao chat de configuração, por exemplo: <em>"crie um workspace com o checkpoint que eu já tenho"</em>.
          </div>
        )}
        {entries.length === 0 && workspaces.length > 0 && (
          <div className="empty">
            <p>
              Descreva a imagem em linguagem natural. O LLM local transforma em um prompt otimizado para{' '}
              <strong>{active ? (BASE_MODEL_PROFILES[active.baseModel]?.label ?? active.baseModel) : 'o modelo'}</strong>.
            </p>
            <p className="muted small">
              Dica: peça ajustes em seguida ("agora à noite", "mais close", "4 variações"). Use <code>/raw</code> para enviar um prompt sem
              refinamento.
            </p>
          </div>
        )}
        {entries.map((entry) => (
          <EntryView
            key={entry.id}
            entry={entry}
            showPrompt={settings.generation.showRefinedPrompt}
            busy={busy}
            onOpen={setLightbox}
            onInsert={(text) => setInput(text)}
          />
        ))}
        {busy && stage && <div className="typing">{STAGE_LABEL[stage]}</div>}
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
          rows={2}
          placeholder={raw ? 'Prompt literal para o modelo (sem refinamento)' : 'Ex.: retrato de uma guerreira élfica ao pôr do sol, luz dourada'}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-side">
          <label className="toggle small" title="Enviar o texto direto como prompt, sem passar pelo LLM local">
            <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> raw
          </label>
          {busy ? (
            <button type="button" className="btn danger" onClick={() => void api.gen.stop()}>
              Parar
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={!input.trim() || !workspaces.length || (!llmReady && !raw)}>
              Gerar
            </button>
          )}
        </div>
      </form>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={imageUrl(lightbox)} alt="" />
          <div className="lightbox-actions" onClick={(e) => e.stopPropagation()}>
            <button className="btn" onClick={() => void api.shell.showItem(lightbox)}>
              Mostrar na pasta
            </button>
            <button className="btn ghost" onClick={() => setLightbox(null)}>
              Fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EntryView({
  entry,
  showPrompt,
  busy,
  onOpen,
  onInsert,
}: {
  entry: GenEntry;
  showPrompt: boolean;
  busy: boolean;
  onOpen: (path: string) => void;
  onInsert: (text: string) => void;
}) {
  if (entry.kind === 'user') return <div className="msg user">{entry.text}</div>;
  if (entry.kind === 'notice') return <div className={`notice ${entry.level}`}>{entry.text}</div>;

  const { job, refined } = entry;
  return (
    <div className="result">
      {refined.comment && <div className="result-comment">{refined.comment}</div>}
      {(job.status === 'queued' || job.status === 'running') && (
        <div className="progress">
          <div className="progress-bar" style={{ width: `${Math.round(job.progress * 100)}%` }} />
        </div>
      )}
      {job.images.length > 0 && (
        <div className={`gallery n${Math.min(job.images.length, 4)}`}>
          {job.images.map((p) => (
            <img
              key={p}
              src={imageUrl(p)}
              alt=""
              style={{ aspectRatio: `${job.width} / ${job.height}` }}
              onClick={() => onOpen(p)}
            />
          ))}
        </div>
      )}
      {job.error && <div className="error small">{job.error}</div>}
      <div className="result-meta small muted">
        <span>{entry.workspaceName}</span>
        <span>
          {job.width}×{job.height}
        </span>
        <span>seed {job.seed}</span>
        {refined.loras && refined.loras.length > 0 && <span>+{refined.loras.map((l) => l.file.replace(/\.\w+$/, '')).join(', ')}</span>}
        <span className="spacer" />
        <button className="btn tiny ghost" disabled={busy} onClick={() => void api.gen.rerun(entry.id, true)}>
          Variar
        </button>
        <button className="btn tiny ghost" disabled={busy} onClick={() => void api.gen.rerun(entry.id, false)}>
          Repetir seed
        </button>
        <button className="btn tiny ghost" onClick={() => onInsert(`/raw ${entry.refined.positive}`)}>
          Editar prompt
        </button>
      </div>
      {showPrompt && (
        <details className="prompt-details">
          <summary>Prompt enviado</summary>
          <div className="small">
            <strong>+</strong> {entry.finalPositive}
          </div>
          {entry.finalNegative && (
            <div className="small muted">
              <strong>−</strong> {entry.finalNegative}
            </div>
          )}
        </details>
      )}
    </div>
  );
}
