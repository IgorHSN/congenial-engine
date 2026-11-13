import { useEffect, useState } from 'react';
import type { ApprovalRequest, McpActivity, McpInfo } from '@shared/types';
import { api } from '../api';

/** Settings tab: use the app's tools from Claude Desktop / Claude Code (Claude subscription, no API key). */
export function McpSettings({ enabled, onToggle }: { enabled: boolean; onToggle: (v: boolean) => void }) {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => void api.mcp.info().then(setInfo);
  useEffect(refresh, [enabled]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMsg(`${label} copiado.`);
    } catch {
      setMsg('Não consegui copiar; selecione o texto e copie manualmente.');
    }
  };

  const install = async () => {
    setMsg(null);
    try {
      const res = await api.mcp.installDesktop();
      setMsg(
        `Adicionado em ${res.path}${res.backup ? ` (backup: ${res.backup})` : ''}. Feche o Claude Desktop por completo (inclusive na bandeja do sistema) e abra de novo.`,
      );
    } catch (err) {
      setMsg(String((err as Error).message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };

  return (
    <>
      <p className="small muted">
        Use o <strong>Claude Desktop</strong> ou o <strong>Claude Code</strong> com a sua assinatura do Claude (Pro/Max) para configurar o
        ComfyUI, sem API key. Eles ganham as mesmas ferramentas do chat de configuração: buscar e baixar modelos, identificar LoRAs, importar
        workflows, criar e testar workspaces. O Comfy Atelier precisa estar aberto. Ações sensíveis (apagar, instalar nós, rodar comandos) pedem
        aprovação nesta janela.
      </p>
      <label className="toggle">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        Permitir conexão do Claude Desktop / Claude Code (servidor local, só neste computador)
      </label>
      {info && (
        <div className="small muted">
          {info.running ? `Ativo em 127.0.0.1:${info.port}.` : enabled ? 'Iniciando… (salve as configurações)' : 'Desligado.'}
          {info.error ? ` Erro: ${info.error}` : ''}
        </div>
      )}
      {info && enabled && (
        <>
          <div className="field">
            <label>Claude Desktop</label>
            <div className="row">
              <button className="btn primary" onClick={() => void install()}>
                Adicionar ao Claude Desktop
              </button>
              <button className="btn" onClick={() => void copy(info.desktopSnippet, 'JSON')}>
                Copiar JSON
              </button>
            </div>
            <div className="hint">
              Edita <code>{info.desktopConfigPath}</code> (com backup). Depois reinicie o Claude Desktop e procure "comfy-atelier" no menu de
              ferramentas/conectores.
            </div>
          </div>
          <div className="field">
            <label>Claude Code</label>
            <pre className="code-block">{info.claudeCodeCommand}</pre>
            <div className="row">
              <button className="btn" onClick={() => void copy(info.claudeCodeCommand, 'Comando')}>
                Copiar comando
              </button>
            </div>
            <div className="hint">Rode uma vez num terminal. Depois, em qualquer sessão do Claude Code: "configure o ComfyUI com o Comfy Atelier…".</div>
          </div>
        </>
      )}
      {msg && <div className="notice info small pre-line">{msg}</div>}
    </>
  );
}

/** Approval cards for actions requested by Claude Desktop / Claude Code. */
export function McpApprovals() {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);
  useEffect(() => {
    const offA = api.mcp.onApproval((req) => setQueue((q) => [...q, req]));
    const offB = api.mcp.onApprovalResolved((id) => setQueue((q) => q.filter((r) => r.requestId !== id)));
    return () => {
      offA();
      offB();
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  const answer = (ok: boolean) => {
    void api.mcp.approve(current.requestId, ok);
    setQueue((q) => q.slice(1));
  };
  return (
    <div className="modal-backdrop">
      <div className={`modal approval-modal ${current.danger}`}>
        <div className="modal-header">
          <h2>Pedido do Claude (Desktop/Code)</h2>
        </div>
        <div className="modal-body">
          <div className="approval-title">{current.title}</div>
          <pre className="approval-details">{current.details}</pre>
          {queue.length > 1 && <div className="small muted">+{queue.length - 1} pedido(s) na fila</div>}
        </div>
        <div className="modal-footer">
          <button className="btn ghost" onClick={() => answer(false)}>
            Negar
          </button>
          <button className="btn primary" onClick={() => answer(true)}>
            Aprovar
          </button>
        </div>
      </div>
    </div>
  );
}

/** Small indicator in the top bar showing what Claude Desktop / Code is doing. */
export function McpActivityChip() {
  const [last, setLast] = useState<McpActivity | null>(null);
  const [, force] = useState(0);
  useEffect(() => api.mcp.onActivity(setLast), []);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!last) return null;
  const age = (Date.now() - new Date(last.at).getTime()) / 1000;
  if (last.phase === 'end' && age > 60) return null;
  return (
    <span className={`chip small mcp-chip ${last.phase === 'start' ? 'busy' : last.ok ? 'ok' : 'bad'}`} title={last.summary ?? ''}>
      Claude (assinatura): {last.tool} {last.phase === 'start' ? '…' : last.ok ? '✓' : '✕'}
    </span>
  );
}
