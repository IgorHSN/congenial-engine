// Types shared between the main process, the preload bridge and the renderer.

/** Model families the app knows how to prompt and wire into a workflow. */
export const BASE_MODELS = [
  'sd15',
  'sdxl',
  'pony',
  'illustrious',
  'noobai',
  'flux',
  'sd35',
  'other',
] as const;
export type BaseModel = (typeof BASE_MODELS)[number];

/** ComfyUI model folders (relative to `<ComfyUI>/models`). */
export const MODEL_FOLDERS = [
  'checkpoints',
  'loras',
  'vae',
  'embeddings',
  'upscale_models',
  'controlnet',
  'clip',
  'text_encoders',
  'unet',
  'diffusion_models',
  'clip_vision',
  'ipadapter',
] as const;
export type ModelFolder = (typeof MODEL_FOLDERS)[number];

export const ASPECTS = ['square', 'portrait', 'landscape', 'wide', 'tall'] as const;
export type Aspect = (typeof ASPECTS)[number];

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type LocalLlmProvider = 'ollama' | 'openai';

export interface Settings {
  comfy: {
    /** Base URL of the ComfyUI server, e.g. http://127.0.0.1:8188 */
    url: string;
    /** Folder that contains ComfyUI's main.py, models/ and custom_nodes/. */
    rootPath: string;
    /** Python used to run ComfyUI and pip (auto-detected when empty). */
    pythonPath: string;
    /** Extra arguments for `python main.py`. */
    extraArgs: string;
    /** Let the app start/stop ComfyUI itself. */
    manageProcess: boolean;
    /** Start ComfyUI when the app opens (requires manageProcess). */
    autoStart: boolean;
  };
  claude: {
    model: string;
    effort: Effort;
    /** Skip the approval card for model downloads (deletes/commands always ask). */
    autoApproveDownloads: boolean;
  };
  localLlm: {
    provider: LocalLlmProvider;
    baseUrl: string;
    model: string;
    temperature: number;
    /** Ollama keep_alive. "0" unloads the LLM right after refining to free VRAM for ComfyUI. */
    keepAlive: string;
  };
  generation: {
    outputDir: string;
    activeWorkspaceId: string | null;
    /** Show the refined prompt under each result. */
    showRefinedPrompt: boolean;
  };
  mcp: {
    /** Expose the app's tools to Claude Desktop / Claude Code through a local MCP bridge. */
    enabled: boolean;
  };
}

/** Settings as exposed to the renderer: secrets are reduced to flags. */
export interface PublicSettings extends Settings {
  secrets: { anthropicApiKey: boolean; civitaiToken: boolean; huggingfaceToken: boolean };
}

export type SecretName = 'anthropicApiKey' | 'civitaiToken' | 'huggingfaceToken';

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ---------------------------------------------------------------------------
// Model inventory

export interface ModelSource {
  kind: 'civitai' | 'huggingface' | 'url';
  url: string;
  civitaiModelId?: number;
  civitaiVersionId?: number;
  hfRepo?: string;
  hfPath?: string;
}

export interface ModelMeta {
  baseModel?: BaseModel;
  triggerWords?: string[];
  /** Most frequent tags from the LoRA's training captions (hints, not guaranteed triggers). */
  trainingTags?: string[];
  /** Where auto-detected metadata came from (absent when set by the user/Claude). */
  detectedFrom?: 'safetensors' | 'civitai-info' | 'lora-manager' | 'a1111' | 'filename';
  recommendedStrength?: number;
  description?: string;
  nsfw?: boolean;
  sha256?: string;
  source?: ModelSource;
  addedAt?: string;
}

export interface InstalledModel {
  folder: ModelFolder;
  /** Path relative to the folder, using forward slashes (what ComfyUI expects). */
  file: string;
  /** Absolute path on disk (the folder may come from extra_model_paths.yaml). */
  path: string;
  sizeBytes: number;
  meta: ModelMeta;
}

// ---------------------------------------------------------------------------
// Workspaces (generation presets the Claude chat creates and the generation chat uses)

export interface LoraRef {
  /** File relative to models/loras. */
  file: string;
  strength: number;
}

/** Per-workspace choice the user makes in the generation chat. */
export type LoraMode = 'auto' | 'on' | 'off';

/** A LoRA that was actually applied to a generation, and why. */
export interface AppliedLora extends LoraRef {
  /** workspace = fixed in the workspace; forced = turned on by the user; auto = picked by the local LLM */
  source: 'workspace' | 'forced' | 'auto';
}

export interface SamplerDefaults {
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  batchSize: number;
  /** 1 = no skip, 2 = "clip skip 2" (CLIPSetLastLayer -2). */
  clipSkip: number;
  /** Flux guidance (FluxGuidance node). */
  guidance: number;
}

export type Pipeline = 'checkpoint' | 'flux' | 'custom';

export interface Workspace {
  id: string;
  name: string;
  description: string;
  baseModel: BaseModel;
  pipeline: Pipeline;
  /** checkpoint pipeline: file in models/checkpoints */
  checkpoint?: string;
  /** flux pipeline: diffusion model in models/unet or models/diffusion_models */
  unet?: string;
  /** flux pipeline: the two text encoders (e.g. clip_l + t5xxl) */
  clip1?: string;
  clip2?: string;
  /** Optional VAE override (required for the flux pipeline). */
  vae?: string;
  /** LoRAs always applied. */
  loras: LoraRef[];
  /** LoRAs the local LLM may choose to add when the request calls for them. */
  optionalLoras: LoraRef[];
  defaults: SamplerDefaults;
  /** Always prepended to the positive prompt (e.g. Pony score tags). */
  positivePrefix: string;
  negativePrompt: string;
  /** Extra style guidance for the local prompt-refiner LLM. */
  refinerNotes: string;
  /**
   * Custom pipeline: a ComfyUI API-format workflow. String values may contain
   * {{positive}}, {{negative}}, {{seed}}, {{width}}, {{height}}, {{steps}},
   * {{cfg}}, {{batch_size}}, {{sampler}}, {{scheduler}}.
   */
  customWorkflow?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Create (no id) or update (id) a workspace; omitted fields keep their value or get family defaults. */
export type WorkspaceInput = Partial<Omit<Workspace, 'createdAt' | 'updatedAt'>> & {
  name: string;
  baseModel: BaseModel;
};

// ---------------------------------------------------------------------------
// Downloads

export type DownloadState = 'queued' | 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';

export interface DownloadInfo {
  id: string;
  label: string;
  folder: ModelFolder;
  file: string;
  url: string;
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number | null;
  bytesPerSecond: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// ComfyUI status

export interface ComfyStatus {
  reachable: boolean;
  url: string;
  version?: string;
  pythonVersion?: string;
  devices?: Array<{ name: string; type: string; vramTotal: number; vramFree: number }>;
  queueRunning?: number;
  queuePending?: number;
  managedProcess: 'stopped' | 'starting' | 'running' | 'exited' | 'unmanaged';
  error?: string;
}

// ---------------------------------------------------------------------------
// Claude (setup) chat

export interface ToolCallView {
  id: string;
  name: string;
  input: unknown;
  status: 'running' | 'awaiting-approval' | 'done' | 'error' | 'denied';
  result?: string;
}

export type ClaudeItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant-text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool'; id: string; call: ToolCallView }
  | { kind: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string };

export interface ApprovalRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  title: string;
  details: string;
  danger: 'low' | 'medium' | 'high';
}

export type ClaudeEvent =
  | { type: 'turn-start' }
  | { type: 'text-delta'; blockKey: string; text: string }
  | { type: 'thinking-delta'; blockKey: string; text: string }
  | { type: 'tool-start'; id: string; name: string }
  | { type: 'tool-running'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; ok: boolean; summary: string }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'approval-resolved'; requestId: string; approved: boolean }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; text: string }
  | { type: 'turn-end'; stopReason: string | null };

// ---------------------------------------------------------------------------
// Generation chat

export interface RefinedPrompt {
  positive: string;
  negative: string;
  aspect?: Aspect;
  width?: number;
  height?: number;
  batchSize?: number;
  steps?: number;
  cfg?: number;
  seed?: number;
  loras?: LoraRef[];
  /** Short note from the LLM to the user (in the user's language). */
  comment?: string;
}

export interface GenerationJob {
  promptId: string | null;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  images: string[];
  seed: number;
  width: number;
  height: number;
  error?: string;
}

export type GenEntry =
  | { kind: 'user'; id: string; text: string; at: string }
  | {
      kind: 'result';
      id: string;
      at: string;
      workspaceId: string;
      workspaceName: string;
      refined: RefinedPrompt;
      /** The exact prompt text sent to ComfyUI (prefix + positive). */
      finalPositive: string;
      finalNegative: string;
      /** LoRAs applied to this generation (absent in entries saved by older versions). */
      loras?: AppliedLora[];
      /** How the size was decided; hires = generated at native size then upscaled in a second pass. */
      size?: { source: SizeSource; hires: boolean; base?: { width: number; height: number }; note?: string };
      job: GenerationJob;
    }
  | { kind: 'notice'; id: string; at: string; level: 'info' | 'warning' | 'error'; text: string };

export type GenEvent =
  | { type: 'entry'; entry: GenEntry }
  | { type: 'entry-update'; entry: GenEntry }
  | { type: 'busy'; busy: boolean; stage?: 'refining' | 'queueing' | 'generating' };

/** How the user asked for the image size. */
export type SizeRequest =
  | { kind: 'auto' }
  | { kind: 'aspect'; aspect: Aspect }
  | { kind: 'ratio'; w: number; h: number }
  | { kind: 'exact'; width: number; height: number };

/** Where the final size came from: typed in the message, the size picker, the local LLM, or the workspace default. */
export type SizeSource = 'text' | 'picker' | 'llm' | 'default' | 'previous';

export interface GenSendOptions {
  /** Skip the local LLM and send the text as the positive prompt. */
  raw?: boolean;
  workspaceId?: string;
  /** User overrides per LoRA file: force on, force off, or let the LLM decide (optional LoRAs). */
  loraModes?: Record<string, LoraMode>;
  /** Size picked in the chat ("auto" lets the message / LLM decide). */
  size?: SizeRequest;
}

export interface ComfyDetection {
  url?: string;
  rootPath?: string;
  /** How the root was found. */
  via?: 'running-server' | 'folder';
  candidates: string[];
}

export interface LlmTestResult {
  ok: boolean;
  models: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// MCP (Claude Desktop / Claude Code using the user's Claude subscription)

export interface McpInfo {
  enabled: boolean;
  running: boolean;
  port: number | null;
  /** JSON to add under "mcpServers" in Claude Desktop's config. */
  desktopSnippet: string;
  desktopConfigPath: string;
  /** Command that registers the server in Claude Code. */
  claudeCodeCommand: string;
  error?: string;
}

export interface McpActivity {
  id: string;
  tool: string;
  phase: 'start' | 'end';
  ok?: boolean;
  summary?: string;
  at: string;
}

export interface SamplerOptions {
  samplers: string[];
  schedulers: string[];
  fromServer: boolean;
}
