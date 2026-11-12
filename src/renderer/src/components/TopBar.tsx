import { useState } from 'react';
import type { ComfyStatus, DownloadInfo, PublicSettings, Workspace } from '@shared/types';
import { api, formatBytes } from '../api';

interface Props {
  settings: PublicSettings;
  status: ComfyStatus | null;
  workspaces: Workspace[];
  downloads: DownloadInfo[];
  onOpenSettings: () => void;
}

export function TopBar({ settings, status, workspaces, downloads, onOpenSettings }: Props) {
  const [showDownloads, setShowDownloads] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState('');
  const active = downloads.filter((d) => d.state === 'downloading' || d.state === 'queued' || d.state === 'verifying');
  const gpu = status?.devices?.find((d) => d.type !== 'cpu') ?? status?.devices?.[0];
  const managed = settings.comfy.manageProcess;

  const openLogs = async () => {
    setLogs(await api.comfy.logs());
    setShowLogs(true);
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden>
          ◆
        </span>
        Comfy Atelier
      </div>

      <div className="status" title={status?.error ?? ''}>
        <span className={`dot ${status?.reachable ? 'ok' : managed && status?.managedProcess === 'starting' ? 'warn' : 'bad'}`} />
        <span>
          ComfyUI{' '}
          {status?.reachable
            ? `${status.version ?? ''} conectado`
            : managed && status?.managedProcess === 'starting'
              ? 'iniciando…'
              : 'desconectado'}
        </span>
        {gpu && status?.reachable && (
          <span className="muted">
            · {gpu.name.replace(/^cuda:\d+\s*/, '').split(':')[0]} · {formatBytes(gpu.vramFree)} livres
          </span>
        )}
        {managed && (
          <>
            {status?.managedProcess === 'running' || status?.managedProcess === 'starting' ? (
              <button className="btn tiny ghost" onClick={() => void api.comfy.stop()}>
                Parar
              </button>
            ) : (
              <button className="btn tiny" onClick={() => void api.comfy.start().catch((e) => alert(String(e)))}>
                Iniciar
              </button>
            )}
            <button className="btn tiny ghost" onClick={() => void openLogs()}>
              Logs
            </button>
          </>
        )}
      </div>

      <div className="spacer" />

      <div className="topbar-actions">
        <span className="muted small">{workspaces.length} workspace{workspaces.length === 1 ? '' : 's'}</span>
        <div className="popover-anchor">
          <button className={`btn ghost ${active.length ? 'pulse' : ''}`} onClick={() => setShowDownloads((v) => !v)}>
            Downloads{active.length ? ` (${active.length})` : ''}
          </button>
          {showDownloads && (
            <div className="popover downloads">
              {downloads.length === 0 && <div className="muted small">Nenhum download ainda.</div>}
              {downloads.map((d) => (
                <div key={d.id} className="download-row">
                  <div className="download-title" title={d.label}>
                    {d.label}
                  </div>
                  <div className="muted small">
                    models/{d.folder}/{d.file}
                  </div>
                  {(d.state === 'downloading' || d.state === 'verifying') && (
                    <div className="progress">
                      <div
                        className="progress-bar"
                        style={{ width: d.totalBytes ? `${(100 * d.receivedBytes) / d.totalBytes}%` : '30%' }}
                      />
                    </div>
                  )}
                  <div className="download-meta small">
                    <span className={`tag ${d.state}`}>{labelFor(d.state)}</span>
                    <span className="muted">
                      {formatBytes(d.receivedBytes)}
                      {d.totalBytes ? ` / ${formatBytes(d.totalBytes)}` : ''}
                      {d.bytesPerSecond ? ` · ${formatBytes(d.bytesPerSecond)}/s` : ''}
                    </span>
                    {(d.state === 'downloading' || d.state === 'queued') && (
                      <button className="btn tiny ghost" onClick={() => void api.downloads.cancel(d.id)}>
                        Cancelar
                      </button>
                    )}
                  </div>
                  {d.error && <div className="error small">{d.error}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
        <button className="btn ghost" onClick={onOpenSettings}>
          Configurações
        </button>
      </div>

      {showLogs && (
        <div className="modal-backdrop" onClick={() => setShowLogs(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Logs do ComfyUI</h2>
              <button className="btn ghost" onClick={() => void openLogs()}>
                Atualizar
              </button>
              <button className="btn ghost" onClick={() => setShowLogs(false)}>
                Fechar
              </button>
            </div>
            <pre className="logs">{logs || 'Sem logs.'}</pre>
          </div>
        </div>
      )}
    </header>
  );
}

function labelFor(state: DownloadInfo['state']): string {
  return {
    queued: 'na fila',
    downloading: 'baixando',
    verifying: 'verificando',
    done: 'concluído',
    error: 'erro',
    cancelled: 'cancelado',
  }[state];
}
