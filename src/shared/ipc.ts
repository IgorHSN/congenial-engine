// IPC channel names shared by main and preload.

export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsSetSecret: 'settings:set-secret',
  settingsPickDirectory: 'settings:pick-directory',
  settingsDetectComfy: 'settings:detect-comfy',
  settingsChanged: 'settings:changed',

  comfyStatus: 'comfy:status',
  comfyStart: 'comfy:start',
  comfyStop: 'comfy:stop',
  comfyLogs: 'comfy:logs',
  comfyStatusChanged: 'comfy:status-changed',

  llmTest: 'llm:test',

  claudeSend: 'claude:send',
  claudeStop: 'claude:stop',
  claudeReset: 'claude:reset',
  claudeTranscript: 'claude:transcript',
  claudeApprove: 'claude:approve',
  claudeEvent: 'claude:event',

  genSend: 'gen:send',
  genStop: 'gen:stop',
  genReset: 'gen:reset',
  genHistory: 'gen:history',
  genRerun: 'gen:rerun',
  genEvent: 'gen:event',

  workspacesList: 'workspaces:list',
  workspacesSetActive: 'workspaces:set-active',
  workspacesDelete: 'workspaces:delete',
  workspacesChanged: 'workspaces:changed',

  modelsList: 'models:list',

  downloadsList: 'downloads:list',
  downloadsCancel: 'downloads:cancel',
  downloadsChanged: 'downloads:changed',

  shellOpenPath: 'shell:open-path',
  shellShowItem: 'shell:show-item',
} as const;

/** Custom protocol used to show generated images in the renderer. */
export const IMAGE_PROTOCOL = 'atelier-img';
