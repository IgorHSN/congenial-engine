import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '@shared/ipc';
import type {
  ClaudeEvent,
  ClaudeItem,
  ComfyDetection,
  ComfyStatus,
  DeepPartial,
  DownloadInfo,
  GenEntry,
  GenEvent,
  GenSendOptions,
  InstalledModel,
  LlmTestResult,
  ModelFolder,
  PublicSettings,
  SecretName,
  Settings,
  Workspace,
} from '@shared/types';

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  settings: {
    get: (): Promise<PublicSettings> => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch: DeepPartial<Settings>): Promise<PublicSettings> => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    setSecret: (name: SecretName, value: string): Promise<PublicSettings> =>
      ipcRenderer.invoke(IPC.settingsSetSecret, name, value),
    pickDirectory: (title: string): Promise<string | null> => ipcRenderer.invoke(IPC.settingsPickDirectory, title),
    detectComfy: (
      path: string,
    ): Promise<{ root: string; python: string | null; kind: string; hasMainPy: boolean; hasModels: boolean } | null> =>
      ipcRenderer.invoke(IPC.settingsDetectComfy, path),
    autoDetect: (): Promise<ComfyDetection> => ipcRenderer.invoke(IPC.settingsAutoDetect),
    onChange: (cb: (s: PublicSettings) => void) => on(IPC.settingsChanged, cb),
  },
  comfy: {
    status: (): Promise<ComfyStatus> => ipcRenderer.invoke(IPC.comfyStatus),
    start: (): Promise<void> => ipcRenderer.invoke(IPC.comfyStart),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.comfyStop),
    logs: (): Promise<string> => ipcRenderer.invoke(IPC.comfyLogs),
    onStatus: (cb: (s: ComfyStatus) => void) => on(IPC.comfyStatusChanged, cb),
  },
  llm: {
    test: (): Promise<LlmTestResult> => ipcRenderer.invoke(IPC.llmTest),
  },
  claude: {
    send: (text: string): Promise<void> => ipcRenderer.invoke(IPC.claudeSend, text),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.claudeStop),
    reset: (): Promise<void> => ipcRenderer.invoke(IPC.claudeReset),
    transcript: (): Promise<{ items: ClaudeItem[]; busy: boolean }> => ipcRenderer.invoke(IPC.claudeTranscript),
    approve: (requestId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke(IPC.claudeApprove, requestId, approved),
    onEvent: (cb: (e: ClaudeEvent) => void) => on(IPC.claudeEvent, cb),
  },
  gen: {
    send: (text: string, opts?: GenSendOptions): Promise<void> => ipcRenderer.invoke(IPC.genSend, text, opts),
    rerun: (entryId: string, newSeed = true): Promise<void> => ipcRenderer.invoke(IPC.genRerun, entryId, newSeed),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.genStop),
    reset: (): Promise<void> => ipcRenderer.invoke(IPC.genReset),
    history: (): Promise<GenEntry[]> => ipcRenderer.invoke(IPC.genHistory),
    onEvent: (cb: (e: GenEvent) => void) => on(IPC.genEvent, cb),
  },
  workspaces: {
    list: (): Promise<Workspace[]> => ipcRenderer.invoke(IPC.workspacesList),
    setActive: (id: string): Promise<void> => ipcRenderer.invoke(IPC.workspacesSetActive, id),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.workspacesDelete, id),
    onChange: (cb: (items: Workspace[]) => void) => on(IPC.workspacesChanged, cb),
  },
  models: {
    list: (folder?: ModelFolder): Promise<InstalledModel[]> => ipcRenderer.invoke(IPC.modelsList, folder),
  },
  downloads: {
    list: (): Promise<DownloadInfo[]> => ipcRenderer.invoke(IPC.downloadsList),
    cancel: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.downloadsCancel, id),
    onChange: (cb: (list: DownloadInfo[]) => void) => on(IPC.downloadsChanged, cb),
  },
  shell: {
    openPath: (p: string): Promise<string> => ipcRenderer.invoke(IPC.shellOpenPath, p),
    showItem: (p: string): Promise<void> => ipcRenderer.invoke(IPC.shellShowItem, p),
  },
};

export type AtelierApi = typeof api;

contextBridge.exposeInMainWorld('atelier', api);
