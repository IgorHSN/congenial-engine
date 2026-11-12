import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, net, protocol, safeStorage, shell } from 'electron';
import { IMAGE_PROTOCOL, IPC } from '@shared/ipc';
import type { ComfyStatus, DeepPartial, GenSendOptions, LlmTestResult, ModelFolder, SecretName, Settings } from '@shared/types';
import { ClaudeAgent } from './claude/agent';
import { ComfyClient } from './comfy/client';
import { ModelInventory } from './comfy/inventory';
import { detectComfyLayout } from './comfy/paths';
import { ComfyProcess } from './comfy/process';
import { LocalLlm } from './generation/llm';
import { GenerationSession } from './generation/session';
import { defaultSettings, SettingsStore } from './settings';
import { CivitaiClient } from './sources/civitai';
import { Downloader } from './sources/downloader';
import { HuggingFaceClient } from './sources/huggingface';
import { WorkspaceStore } from './workspaces';

protocol.registerSchemesAsPrivileged([
  { scheme: IMAGE_PROTOCOL, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow: BrowserWindow | null = null;

function send(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function isInside(base: string, target: string): boolean {
  if (!base) return false;
  const r = relative(resolve(base), resolve(target));
  return !!r && !r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r);
}

async function bootstrap(): Promise<void> {
  const dataDir = app.getPath('userData');
  const settings = new SettingsStore(dataDir, defaultSettings(app.getPath('pictures')), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
  });
  await settings.load();
  const cfg = (): Settings => settings.get();

  const comfy = new ComfyClient(() => cfg().comfy.url);
  const proc = new ComfyProcess(cfg);
  const inventory = new ModelInventory(dataDir, () => {
    const root = cfg().comfy.rootPath;
    return root ? (detectComfyLayout(root)?.root ?? root) : '';
  });
  const workspaces = new WorkspaceStore(dataDir);
  await workspaces.load();
  const downloader = new Downloader();
  const civitai = new CivitaiClient(() => settings.getSecret('civitaiToken'));
  const hf = new HuggingFaceClient(() => settings.getSecret('huggingfaceToken'));
  const llm = new LocalLlm(() => cfg().localLlm);

  const setActiveWorkspace = async (id: string) => {
    await settings.update({ generation: { activeWorkspaceId: id } });
  };

  const agent = new ClaudeAgent({
    dataDir,
    settings: cfg,
    apiKey: () => settings.getSecret('anthropicApiKey'),
    emit: (e) => send(IPC.claudeEvent, e),
    toolContext: {
      settings: cfg,
      comfy,
      process: proc,
      inventory,
      civitai,
      hf,
      downloader,
      workspaces,
      setActiveWorkspace,
      previewImage: async (path) => {
        const img = nativeImage.createFromPath(path);
        if (img.isEmpty()) return null;
        const { width } = img.getSize();
        const small = width > 768 ? img.resize({ width: 768, quality: 'good' }) : img;
        return { data: small.toJPEG(82).toString('base64'), mediaType: 'image/jpeg' };
      },
    },
  });
  await agent.load();

  const gen = new GenerationSession({
    dataDir,
    settings: cfg,
    comfy,
    llm,
    inventory,
    workspaces,
    emit: (e) => send(IPC.genEvent, e),
  });
  await gen.load();

  // --- push updates to the renderer
  settings.onChange(() => send(IPC.settingsChanged, settings.getPublic()));
  workspaces.onChange((items) => send(IPC.workspacesChanged, items));
  downloader.onChange((list) => send(IPC.downloadsChanged, list));

  let lastStatus = '';
  const computeStatus = async (): Promise<ComfyStatus> => {
    const s = cfg().comfy;
    const status: ComfyStatus = { reachable: false, url: s.url, managedProcess: s.manageProcess ? proc.state : 'unmanaged' };
    try {
      const stats = await comfy.systemStats();
      status.reachable = true;
      status.version = stats.system?.comfyui_version;
      status.pythonVersion = stats.system?.python_version?.split(' ')[0];
      status.devices = stats.devices?.map((d) => ({ name: d.name, type: d.type, vramTotal: d.vram_total, vramFree: d.vram_free }));
      const q = await comfy.queue().catch(() => null);
      status.queueRunning = q?.running;
      status.queuePending = q?.pending;
      if (s.manageProcess && proc.state === 'starting') proc.state = 'running';
    } catch (err) {
      status.error = (err as Error).message;
    }
    return status;
  };
  const pollStatus = async () => {
    const status = await computeStatus();
    const key = JSON.stringify({ ...status, devices: status.devices?.map((d) => d.name) });
    if (key !== lastStatus) {
      lastStatus = key;
      send(IPC.comfyStatusChanged, status);
    }
  };
  setInterval(() => void pollStatus(), 4000);
  proc.onChange(() => void pollStatus());

  // --- images protocol (only files inside the output folder)
  protocol.handle(IMAGE_PROTOCOL, (request) => {
    const p = new URL(request.url).searchParams.get('p') ?? '';
    const allowed = [cfg().generation.outputDir];
    if (!p || !allowed.some((base) => isInside(base, p))) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(p).toString());
  });

  // --- IPC
  ipcMain.handle(IPC.settingsGet, () => settings.getPublic());
  ipcMain.handle(IPC.settingsUpdate, async (_e, patch: DeepPartial<Settings>) => {
    await settings.update(patch);
    return settings.getPublic();
  });
  ipcMain.handle(IPC.settingsSetSecret, async (_e, name: SecretName, value: string) => {
    if (!['anthropicApiKey', 'civitaiToken', 'huggingfaceToken'].includes(name)) throw new Error('Segredo desconhecido.');
    await settings.setSecret(name, value);
    return settings.getPublic();
  });
  ipcMain.handle(IPC.settingsPickDirectory, async (_e, title: string) => {
    const res = await dialog.showOpenDialog(mainWindow!, { title, properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.settingsDetectComfy, (_e, path: string) => detectComfyLayout(path));

  ipcMain.handle(IPC.comfyStatus, () => computeStatus());
  ipcMain.handle(IPC.comfyStart, () => {
    proc.start();
  });
  ipcMain.handle(IPC.comfyStop, () => proc.stop());
  ipcMain.handle(IPC.comfyLogs, () => proc.tail(400));

  ipcMain.handle(IPC.llmTest, async (): Promise<LlmTestResult> => {
    try {
      return { ok: true, models: await llm.listModels() };
    } catch (err) {
      return { ok: false, models: [], error: (err as Error).message };
    }
  });

  ipcMain.handle(IPC.claudeSend, (_e, text: string) => {
    void agent.send(String(text)).catch((err) => send(IPC.claudeEvent, { type: 'notice', level: 'error', text: String(err) }));
  });
  ipcMain.handle(IPC.claudeStop, () => agent.stop());
  ipcMain.handle(IPC.claudeReset, () => agent.reset());
  ipcMain.handle(IPC.claudeTranscript, () => ({ items: agent.transcript(), busy: agent.busy }));
  ipcMain.handle(IPC.claudeApprove, (_e, requestId: string, approved: boolean) => agent.respondApproval(requestId, !!approved));

  ipcMain.handle(IPC.genSend, (_e, text: string, opts?: GenSendOptions) => {
    void gen.send(String(text), opts ?? {}).catch((err) => console.error('generation failed:', err));
  });
  ipcMain.handle(IPC.genRerun, (_e, entryId: string, newSeed: boolean) => {
    void gen.rerun(entryId, newSeed !== false).catch((err) => console.error('rerun failed:', err));
  });
  ipcMain.handle(IPC.genStop, () => gen.stop());
  ipcMain.handle(IPC.genReset, () => gen.reset());
  ipcMain.handle(IPC.genHistory, () => gen.history());

  ipcMain.handle(IPC.workspacesList, () => workspaces.list());
  ipcMain.handle(IPC.workspacesSetActive, (_e, id: string) => setActiveWorkspace(id));
  ipcMain.handle(IPC.workspacesDelete, (_e, id: string) => workspaces.remove(id));

  ipcMain.handle(IPC.modelsList, async (_e, folder?: ModelFolder) => {
    try {
      return await inventory.list(folder);
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.downloadsList, () => downloader.list());
  ipcMain.handle(IPC.downloadsCancel, (_e, id: string) => downloader.cancel(id));

  const shellAllowed = (p: string) => {
    const s = cfg();
    const root = s.comfy.rootPath ? (detectComfyLayout(s.comfy.rootPath)?.root ?? s.comfy.rootPath) : '';
    return resolve(p) === resolve(s.generation.outputDir) || isInside(s.generation.outputDir, p) || (root && (resolve(p) === resolve(root) || isInside(root, p)));
  };
  ipcMain.handle(IPC.shellOpenPath, async (_e, p: string) => {
    if (!shellAllowed(p)) throw new Error('Caminho não permitido.');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(p, { recursive: true }).catch(() => undefined);
    return shell.openPath(p);
  });
  ipcMain.handle(IPC.shellShowItem, (_e, p: string) => {
    if (!shellAllowed(p)) throw new Error('Caminho não permitido.');
    shell.showItemInFolder(p);
  });

  if (cfg().comfy.manageProcess && cfg().comfy.autoStart) {
    try {
      proc.start();
    } catch (err) {
      console.error('ComfyUI auto-start failed:', err);
    }
  }

  app.on('before-quit', () => {
    void proc.stop();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1115',
    title: 'Comfy Atelier',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on('ready-to-show', () => mainWindow?.show());

  // Links open in the system browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL)) return;
    event.preventDefault();
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  await bootstrap();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
