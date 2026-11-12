import { existsSync, promises as fs } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { BASE_MODELS, MODEL_FOLDERS, type ApprovalRequest, type ModelFolder, type Settings } from '@shared/types';
import type { ComfyClient } from '../comfy/client';
import type { ModelInventory } from '../comfy/inventory';
import { detectComfyLayout, modelsDir, safeJoin, sanitizeFileName } from '../comfy/paths';
import type { ComfyProcess } from '../comfy/process';
import { buildWorkflow, randomSeed } from '../comfy/workflow';
import { runProcess } from '../proc';
import {
  CIVITAI_TYPES,
  civitaiBaseModel,
  civitaiFolder,
  parseCivitaiRef,
  pickCivitaiFile,
  stripHtml,
  summarizeCivitaiModel,
  summarizeCivitaiVersion,
  type CivitaiClient,
} from '../sources/civitai';
import type { Downloader } from '../sources/downloader';
import { parseHfUrl, type HuggingFaceClient } from '../sources/huggingface';
import type { WorkspaceStore } from '../workspaces';

export interface ToolContext {
  settings: () => Settings;
  comfy: ComfyClient;
  process: ComfyProcess;
  inventory: ModelInventory;
  civitai: CivitaiClient;
  hf: HuggingFaceClient;
  downloader: Downloader;
  workspaces: WorkspaceStore;
  /** Ask the user to approve an action. Resolves false when denied or cancelled. */
  approve: (req: Omit<ApprovalRequest, 'requestId' | 'toolUseId'>) => Promise<boolean>;
  setActiveWorkspace: (id: string) => Promise<void>;
  /** Downscale an image for Claude to look at (JPEG base64). */
  previewImage: (path: string) => Promise<{ data: string; mediaType: 'image/jpeg' | 'image/png' } | null>;
  signal: AbortSignal;
}

export type ToolOutput = string | Anthropic.Beta.BetaToolResultBlockParam['content'];

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolOutput>;
}

function tool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export class ToolError extends Error {}

const folderEnum = z.enum(MODEL_FOLDERS);
const baseModelEnum = z.enum(BASE_MODELS);
const loraRef = z.object({
  file: z.string().describe('File relative to models/loras, exactly as list_models shows it'),
  strength: z.number().min(-4).max(4),
});

const json = (v: unknown) => JSON.stringify(v, null, 1);
const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

function requireRoot(ctx: ToolContext): string {
  const root = ctx.settings().comfy.rootPath;
  if (!root) throw new ToolError('ComfyUI root folder is not configured. Ask the user to set it in Settings → ComfyUI.');
  return detectComfyLayout(root)?.root ?? root;
}

function pythonFor(ctx: ToolContext): string {
  const s = ctx.settings().comfy;
  return s.pythonPath || detectComfyLayout(s.rootPath)?.python || (process.platform === 'win32' ? 'python' : 'python3');
}

// ---------------------------------------------------------------------------

export const TOOLS = [
  tool({
    name: 'comfy_status',
    description:
      'Check whether ComfyUI is reachable and how it is set up: server version, GPU/VRAM, queue, configured root folder, ' +
      'python used, whether the app manages the ComfyUI process, and how many model files exist per folder. Call this first in a new session.',
    schema: z.object({}),
    run: async (_input, ctx) => {
      const s = ctx.settings();
      const layout = s.comfy.rootPath ? detectComfyLayout(s.comfy.rootPath) : null;
      const out: Record<string, unknown> = {
        url: s.comfy.url,
        rootPath: layout?.root ?? (s.comfy.rootPath || null),
        layout: layout ? { kind: layout.kind, hasMainPy: layout.hasMainPy, hasModels: layout.hasModels } : null,
        python: s.comfy.rootPath ? pythonFor(ctx) : null,
        managedProcess: s.comfy.manageProcess ? ctx.process.state : 'unmanaged',
        activeWorkspaceId: s.generation.activeWorkspaceId,
        workspaces: ctx.workspaces.list().length,
      };
      try {
        const stats = await ctx.comfy.systemStats();
        const q = await ctx.comfy.queue().catch(() => null);
        out.reachable = true;
        out.comfyuiVersion = stats.system?.comfyui_version;
        out.pythonVersion = stats.system?.python_version?.split(' ')[0];
        out.os = stats.system?.os;
        out.devices = stats.devices?.map((d) => ({
          name: d.name,
          vramTotalGB: Math.round((d.vram_total / 1024 ** 3) * 10) / 10,
          vramFreeGB: Math.round((d.vram_free / 1024 ** 3) * 10) / 10,
        }));
        out.queue = q;
      } catch (err) {
        out.reachable = false;
        out.error = (err as Error).message;
      }
      if (layout?.hasModels) {
        const counts: Record<string, number> = {};
        for (const m of await ctx.inventory.list()) counts[m.folder] = (counts[m.folder] ?? 0) + 1;
        out.modelCounts = counts;
      }
      return json(out);
    },
  }),

  tool({
    name: 'list_models',
    description:
      'List model files installed in ComfyUI (from disk), with size and any metadata the app knows (base model, trigger words, ' +
      'recommended strength, source). Use the "file" values exactly as returned when building workspaces.',
    schema: z.object({
      folder: folderEnum.optional().describe('Only this folder (e.g. checkpoints, loras). Omit for all.'),
      search: z.string().optional().describe('Case-insensitive substring filter on the file name'),
    }),
    run: async ({ folder, search }, ctx) => {
      requireRoot(ctx);
      let items = await ctx.inventory.list(folder);
      if (search) items = items.filter((m) => m.file.toLowerCase().includes(search.toLowerCase()));
      return json({
        count: items.length,
        models: items.slice(0, 200).map((m) => ({
          folder: m.folder,
          file: m.file,
          sizeMB: mb(m.sizeBytes),
          baseModel: m.meta.baseModel,
          triggerWords: m.meta.triggerWords?.slice(0, 8),
          recommendedStrength: m.meta.recommendedStrength,
          description: m.meta.description?.slice(0, 160),
          source: m.meta.source?.url,
        })),
        truncated: items.length > 200,
      });
    },
  }),

  tool({
    name: 'search_civitai',
    description:
      'Search Civitai for checkpoints, LoRAs, embeddings, VAEs, ControlNets or upscalers. Returns model ids, versions, base model, ' +
      'trigger words and files. Prefer filtering by type and base model so results are compatible with the user\'s checkpoint.',
    schema: z.object({
      query: z.string().describe('Search text, e.g. "realistic skin", "watercolor style", "cyberpunk"'),
      types: z.array(z.enum(CIVITAI_TYPES)).optional(),
      base_models: z
        .array(z.string())
        .optional()
        .describe('Civitai base model names, e.g. "SD 1.5", "SDXL 1.0", "Pony", "Illustrious", "NoobAI", "Flux.1 D"'),
      nsfw: z.boolean().optional().describe('Include NSFW models (the user is an adult; omit to use Civitai defaults)'),
      sort: z.enum(['Highest Rated', 'Most Downloaded', 'Newest']).optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    run: async (input, ctx) => {
      const res = await ctx.civitai.search({
        query: input.query,
        types: input.types,
        baseModels: input.base_models,
        nsfw: input.nsfw,
        sort: input.sort,
        limit: input.limit ?? 8,
      });
      return json(res.items.map((m) => summarizeCivitaiModel(m, 2)));
    },
  }),

  tool({
    name: 'get_civitai_model',
    description:
      'Get details of a Civitai model from a URL (civitai.com/models/...), a model id, or a version id: description, all versions, ' +
      'base model, trigger words and downloadable files. Use before download_model when the user pastes a link.',
    schema: z.object({
      ref: z.string().optional().describe('Civitai URL or numeric model id'),
      version_id: z.number().int().optional().describe('Specific model version id'),
    }),
    run: async ({ ref, version_id }, ctx) => {
      const parsed = ref ? parseCivitaiRef(ref) : null;
      const versionId = version_id ?? parsed?.versionId;
      if (versionId && !parsed?.modelId) {
        const v = await ctx.civitai.version(versionId);
        return json({ model: v.model, modelId: v.modelId, version: summarizeCivitaiVersion(v), description: stripHtml(v.description) });
      }
      if (!parsed?.modelId) throw new ToolError('Could not find a Civitai model id in the reference.');
      const m = await ctx.civitai.model(parsed.modelId);
      const summary = summarizeCivitaiModel(m, 6);
      return json({ ...summary, highlightedVersionId: versionId, description: stripHtml(m.description) });
    },
  }),

  tool({
    name: 'search_huggingface',
    description: 'Search Hugging Face model repositories (e.g. official Flux/SDXL weights, text encoders, VAEs, upscalers).',
    schema: z.object({ query: z.string(), limit: z.number().int().min(1).max(30).optional() }),
    run: async ({ query, limit }, ctx) => json(await ctx.hf.search(query, limit ?? 10)),
  }),

  tool({
    name: 'list_huggingface_files',
    description: 'List the files in a Hugging Face repository (path and size) to pick what to download. Accepts a repo id or a URL.',
    schema: z.object({
      repo: z.string().describe('owner/name or a huggingface.co URL'),
      revision: z.string().optional(),
      filter: z.string().optional().describe('Substring filter, e.g. ".safetensors" or "fp8"'),
    }),
    run: async ({ repo, revision, filter }, ctx) => {
      const parsed = parseHfUrl(repo);
      const files = await ctx.hf.listFiles(parsed?.repo ?? repo, revision ?? parsed?.revision ?? 'main');
      const filtered = filter ? files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())) : files;
      return json(filtered.slice(0, 150).map((f) => ({ path: f.path, sizeMB: mb(f.size) })));
    },
  }),

  tool({
    name: 'download_model',
    description:
      'Download a model file into the right ComfyUI models folder and record its metadata. Shows the user an approval card ' +
      '(unless they enabled auto-approve) and waits until the download finishes. Sources: a Civitai model version, a file in a ' +
      'Hugging Face repo, or a direct URL. Always fill base_model and trigger_words when known: the generation chat uses them.',
    schema: z.object({
      source: z.enum(['civitai', 'huggingface', 'url']),
      civitai_version_id: z.number().int().optional(),
      civitai_file_name: z.string().optional().describe('Pick a specific file of the version (default: primary safetensors)'),
      hf_repo: z.string().optional(),
      hf_path: z.string().optional().describe('File path inside the repo'),
      hf_revision: z.string().optional(),
      url: z.string().optional(),
      folder: folderEnum.optional().describe('Destination folder; inferred from the Civitai model type when omitted'),
      subfolder: z.string().optional().describe('Optional subfolder inside the destination, e.g. "pony"'),
      filename: z.string().optional().describe('Override the saved file name'),
      base_model: baseModelEnum.optional(),
      trigger_words: z.array(z.string()).optional(),
      recommended_strength: z.number().optional(),
      description: z.string().optional().describe('One line describing what it does (shown to the local prompt LLM)'),
      nsfw: z.boolean().optional(),
    }),
    run: async (input, ctx) => {
      const root = requireRoot(ctx);
      let url: string;
      let fileName: string;
      let folder: ModelFolder | undefined = input.folder;
      let sha256: string | undefined;
      let headers: Record<string, string> | undefined;
      let label: string;
      const meta = {
        baseModel: input.base_model,
        triggerWords: input.trigger_words,
        recommendedStrength: input.recommended_strength,
        description: input.description,
        nsfw: input.nsfw,
        source: undefined as undefined | import('@shared/types').ModelSource,
      };

      if (input.source === 'civitai') {
        if (!input.civitai_version_id) throw new ToolError('civitai_version_id is required for source=civitai');
        const v = await ctx.civitai.version(input.civitai_version_id);
        const file = pickCivitaiFile(v.files, input.civitai_file_name);
        if (!file) throw new ToolError('That version has no downloadable files.');
        url = ctx.civitai.downloadUrl(file);
        fileName = input.filename ?? file.name;
        folder ??= civitaiFolder(v.model?.type);
        sha256 = file.hashes?.SHA256;
        label = `${v.model?.name ?? 'Civitai'} — ${v.name}`;
        meta.baseModel ??= civitaiBaseModel(v.baseModel);
        meta.triggerWords ??= v.trainedWords?.length ? v.trainedWords : undefined;
        meta.nsfw ??= v.model?.nsfw;
        meta.source = {
          kind: 'civitai',
          url: `https://civitai.com/models/${v.modelId}?modelVersionId=${v.id}`,
          civitaiModelId: v.modelId,
          civitaiVersionId: v.id,
        };
      } else if (input.source === 'huggingface') {
        if (!input.hf_repo || !input.hf_path) throw new ToolError('hf_repo and hf_path are required for source=huggingface');
        const rev = input.hf_revision ?? 'main';
        url = ctx.hf.downloadUrl(input.hf_repo, input.hf_path, rev);
        headers = ctx.hf.headers();
        fileName = input.filename ?? basename(input.hf_path);
        label = `${input.hf_repo}/${input.hf_path}`;
        const files = await ctx.hf.listFiles(input.hf_repo, rev).catch(() => []);
        sha256 = files.find((f) => f.path === input.hf_path)?.sha256;
        meta.source = { kind: 'huggingface', url: `https://huggingface.co/${input.hf_repo}`, hfRepo: input.hf_repo, hfPath: input.hf_path };
      } else {
        if (!input.url || !/^https:\/\//i.test(input.url)) throw new ToolError('A direct https:// url is required for source=url');
        const parsedHf = parseHfUrl(input.url);
        const parsedCivitai = parseCivitaiRef(input.url);
        if (parsedCivitai?.versionId) {
          throw new ToolError('This is a Civitai link: use source=civitai with civitai_version_id instead.');
        }
        url = input.url;
        if (parsedHf?.path) {
          url = ctx.hf.downloadUrl(parsedHf.repo, parsedHf.path, parsedHf.revision);
          headers = ctx.hf.headers();
        }
        fileName = input.filename ?? decodeURIComponent(basename(new URL(input.url).pathname)) ?? 'model.safetensors';
        label = fileName;
        meta.source = { kind: 'url', url: input.url };
      }
      if (!folder) throw new ToolError('folder is required (could not infer it).');

      const safeName = sanitizeFileName(fileName);
      const rel = input.subfolder ? `${input.subfolder.replace(/^[\\/]+|[\\/]+$/g, '')}/${safeName}` : safeName;
      const dest = safeJoin(modelsDir(root, folder), rel);
      if (existsSync(dest)) {
        await ctx.inventory.setMeta(folder, rel, { ...meta, sha256, addedAt: new Date().toISOString() });
        return json({ status: 'already_installed', folder, file: rel, note: 'Metadata updated.' });
      }

      if (!ctx.settings().claude.autoApproveDownloads) {
        const ok = await ctx.approve({
          toolName: 'download_model',
          title: `Baixar ${label}`,
          details: `Destino: models/${folder}/${rel}\nOrigem: ${url.replace(/token=[^&]+/, 'token=***')}`,
          danger: 'low',
        });
        if (!ok) return 'USER_DENIED: the user declined this download.';
      }

      const { id, done } = ctx.downloader.enqueue({ label, url, folder, file: rel, dest, headers, expectedSha256: sha256 });
      const info = await done;
      if (info.state !== 'done') {
        throw new ToolError(`Download ${id} ${info.state}: ${info.error ?? ''}`.trim());
      }
      await ctx.inventory.setMeta(folder, rel, { ...meta, sha256, addedAt: new Date().toISOString() });
      return json({ status: 'installed', folder, file: rel, sizeMB: mb(info.receivedBytes), verified: !!sha256, metadata: meta });
    },
  }),

  tool({
    name: 'delete_model',
    description: 'Delete a model file from ComfyUI (asks the user to confirm).',
    schema: z.object({ folder: folderEnum, file: z.string() }),
    run: async ({ folder, file }, ctx) => {
      requireRoot(ctx);
      if (!(await ctx.inventory.exists(folder, file))) throw new ToolError(`models/${folder}/${file} not found.`);
      const ok = await ctx.approve({
        toolName: 'delete_model',
        title: `Apagar models/${folder}/${file}`,
        details: 'O arquivo será removido do disco.',
        danger: 'high',
      });
      if (!ok) return 'USER_DENIED: the user declined the deletion.';
      await ctx.inventory.remove(folder, file);
      return `Deleted models/${folder}/${file}.`;
    },
  }),

  tool({
    name: 'update_model_metadata',
    description:
      'Set app-side metadata for an installed model (base model, trigger words, recommended strength, description). ' +
      'The local prompt LLM reads this to use LoRAs correctly.',
    schema: z.object({
      folder: folderEnum,
      file: z.string(),
      base_model: baseModelEnum.optional(),
      trigger_words: z.array(z.string()).optional(),
      recommended_strength: z.number().optional(),
      description: z.string().optional(),
      nsfw: z.boolean().optional(),
    }),
    run: async (i, ctx) => {
      requireRoot(ctx);
      if (!(await ctx.inventory.exists(i.folder, i.file))) throw new ToolError(`models/${i.folder}/${i.file} not found.`);
      const meta = await ctx.inventory.setMeta(i.folder, i.file, {
        baseModel: i.base_model,
        triggerWords: i.trigger_words,
        recommendedStrength: i.recommended_strength,
        description: i.description,
        nsfw: i.nsfw,
      });
      return json({ folder: i.folder, file: i.file, meta });
    },
  }),

  tool({
    name: 'identify_local_model',
    description:
      'Identify a model file the user already had (not downloaded by the app): hashes it (SHA-256, may take ~10-30 s for big files) ' +
      'and looks it up on Civitai to fill base model and trigger words.',
    schema: z.object({ folder: folderEnum, file: z.string() }),
    run: async ({ folder, file }, ctx) => {
      requireRoot(ctx);
      const sha256 = await ctx.inventory.sha256(folder, file);
      try {
        const v = await ctx.civitai.versionByHash(sha256);
        const meta = await ctx.inventory.setMeta(folder, file, {
          sha256,
          baseModel: civitaiBaseModel(v.baseModel),
          triggerWords: v.trainedWords?.length ? v.trainedWords : undefined,
          nsfw: v.model?.nsfw,
          source: {
            kind: 'civitai',
            url: `https://civitai.com/models/${v.modelId}?modelVersionId=${v.id}`,
            civitaiModelId: v.modelId,
            civitaiVersionId: v.id,
          },
        });
        return json({ found: true, name: v.model?.name, version: v.name, baseModel: v.baseModel, meta });
      } catch {
        await ctx.inventory.setMeta(folder, file, { sha256 });
        return json({ found: false, sha256, autoV2: sha256.slice(0, 10).toUpperCase(), note: 'Not found on Civitai. Ask the user or set metadata manually.' });
      }
    },
  }),

  tool({
    name: 'list_custom_nodes',
    description: 'List installed ComfyUI custom node packs (folders in custom_nodes) and their git remotes.',
    schema: z.object({}),
    run: async (_i, ctx) => {
      const dir = join(requireRoot(ctx), 'custom_nodes');
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      const out = [];
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === '__pycache__') continue;
        let remote: string | undefined;
        try {
          const cfg = await fs.readFile(join(dir, e.name, '.git', 'config'), 'utf8');
          remote = cfg.match(/url\s*=\s*(.+)/)?.[1]?.trim();
        } catch {
          /* not a git checkout */
        }
        out.push({ name: e.name, disabled: e.name.endsWith('.disabled'), remote });
      }
      return json(out);
    },
  }),

  tool({
    name: 'install_custom_node',
    description:
      'Install a ComfyUI custom node pack: git clone into custom_nodes and pip install its requirements with ComfyUI\'s python. ' +
      'Asks the user to approve. ComfyUI must be restarted afterwards (restart_comfyui).',
    schema: z.object({
      git_url: z.string().describe('https git URL, e.g. https://github.com/ltdrdata/ComfyUI-Impact-Pack'),
      install_requirements: z.boolean().optional(),
    }),
    run: async ({ git_url, install_requirements }, ctx) => {
      const root = requireRoot(ctx);
      let url: URL;
      try {
        url = new URL(git_url);
      } catch {
        throw new ToolError('Invalid URL.');
      }
      if (url.protocol !== 'https:') throw new ToolError('Only https git URLs are allowed.');
      const name = basename(url.pathname).replace(/\.git$/, '');
      if (!/^[\w.-]+$/.test(name)) throw new ToolError('Unexpected repository name.');
      const target = join(root, 'custom_nodes', name);
      if (existsSync(target)) return json({ status: 'already_installed', path: target });

      const python = pythonFor(ctx);
      const ok = await ctx.approve({
        toolName: 'install_custom_node',
        title: `Instalar custom node ${name}`,
        details: `git clone --depth 1 ${url.toString()}\n→ ${target}${install_requirements === false ? '' : `\n${python} -m pip install -r requirements.txt`}`,
        danger: 'medium',
      });
      if (!ok) return 'USER_DENIED: the user declined the installation.';

      const clone = await runProcess('git', ['clone', '--depth', '1', url.toString(), target], {
        timeoutMs: 5 * 60 * 1000,
        signal: ctx.signal,
      });
      if (clone.code !== 0) throw new ToolError(`git clone failed (exit ${clone.code}):\n${clone.output.slice(-3000)}`);

      let pipLog = '';
      if (install_requirements !== false && existsSync(join(target, 'requirements.txt'))) {
        const pip = await runProcess(python, ['-m', 'pip', 'install', '-r', 'requirements.txt'], {
          cwd: target,
          timeoutMs: 20 * 60 * 1000,
          signal: ctx.signal,
        });
        pipLog = pip.output.slice(-2500);
        if (pip.code !== 0) {
          return json({ status: 'cloned_but_pip_failed', path: target, exitCode: pip.code, log: pipLog });
        }
      }
      return json({ status: 'installed', path: target, pipLogTail: pipLog || undefined, next: 'Restart ComfyUI to load it.' });
    },
  }),

  tool({
    name: 'run_command',
    description:
      'Run a shell command on the user\'s computer (asks for approval every time). Use only when no dedicated tool fits: ' +
      'installing ComfyUI itself, updating it (git pull), pip-installing a missing dependency, checking versions. ' +
      'Explain why before calling. Default working directory is the ComfyUI root.',
    schema: z.object({
      command: z.string(),
      cwd: z.string().optional().describe('Absolute path, or relative to the ComfyUI root'),
      timeout_seconds: z.number().int().min(5).max(3600).optional(),
      reason: z.string().describe('Short explanation shown to the user in the approval card'),
    }),
    run: async ({ command, cwd, timeout_seconds, reason }, ctx) => {
      const rootSetting = ctx.settings().comfy.rootPath;
      const base = rootSetting ? (detectComfyLayout(rootSetting)?.root ?? rootSetting) : process.cwd();
      const dir = cwd ? (isAbsolute(cwd) ? cwd : resolve(base, cwd)) : base;
      const ok = await ctx.approve({
        toolName: 'run_command',
        title: 'Executar comando',
        details: `${reason}\n\n$ ${command}\n(em ${dir})`,
        danger: 'high',
      });
      if (!ok) return 'USER_DENIED: the user declined to run this command.';
      const res = await runProcess(command, [], {
        cwd: dir,
        shell: true,
        timeoutMs: (timeout_seconds ?? 600) * 1000,
        signal: ctx.signal,
        maxOutput: 8000,
      });
      return json({ exitCode: res.code, timedOut: res.timedOut, output: res.output });
    },
  }),

  tool({
    name: 'comfy_node_info',
    description:
      'Inspect ComfyUI nodes available on the running server: either search node class names, or get one node\'s inputs/outputs ' +
      '(including the allowed values of combo inputs, e.g. sampler names, scheduler names, files a loader can see).',
    schema: z.object({
      node_class: z.string().optional().describe('Exact class name, e.g. "KSampler" or "LoraLoader"'),
      search: z.string().optional().describe('Substring to search in class names / display names'),
    }),
    run: async ({ node_class, search }, ctx) => {
      if (node_class) {
        const info = await ctx.comfy.objectInfo(node_class);
        const node = info[node_class];
        if (!node) throw new ToolError(`Node ${node_class} not found (custom node not installed or ComfyUI not restarted?).`);
        const describeInputs = (inputs?: Record<string, unknown[]>) =>
          Object.fromEntries(
            Object.entries(inputs ?? {}).map(([k, spec]) => {
              const [type, opts] = spec as [unknown, Record<string, unknown> | undefined];
              if (Array.isArray(type)) return [k, { options: type.slice(0, 60), more: Math.max(0, type.length - 60) }];
              return [k, { type, ...(opts ? { default: opts.default, min: opts.min, max: opts.max } : {}) }];
            }),
          );
        return json({
          name: node.name,
          category: node.category,
          description: node.description,
          required: describeInputs(node.input?.required),
          optional: describeInputs(node.input?.optional),
          outputs: node.output,
        });
      }
      const all = await ctx.comfy.objectInfo();
      const q = (search ?? '').toLowerCase();
      const matches = Object.values(all)
        .filter((n) => !q || n.name.toLowerCase().includes(q) || (n.display_name ?? '').toLowerCase().includes(q))
        .slice(0, 60)
        .map((n) => ({ name: n.name, display: n.display_name, category: n.category }));
      return json({ total: Object.keys(all).length, matches });
    },
  }),

  tool({
    name: 'restart_comfyui',
    description:
      'Restart ComfyUI (needed after installing custom nodes). Works when the app manages the ComfyUI process or ComfyUI-Manager is installed; ' +
      'otherwise tells you to ask the user to restart it manually.',
    schema: z.object({}),
    run: async (_i, ctx) => {
      if (ctx.settings().comfy.manageProcess) {
        await ctx.process.restart();
        return 'Restart requested (app-managed process). It can take ~10-60 s to come back; check with comfy_status.';
      }
      const ok = await ctx.comfy.managerReboot();
      return ok
        ? 'Restart requested via ComfyUI-Manager. Check comfy_status in a few seconds.'
        : 'Could not restart automatically: ask the user to restart ComfyUI (or enable "app manages ComfyUI" in Settings).';
    },
  }),

  tool({
    name: 'list_workspaces',
    description:
      'List generation workspaces (presets used by the generation chat: model, LoRAs, sampler defaults, prompt prefix/negative, notes for the local LLM).',
    schema: z.object({}),
    run: async (_i, ctx) =>
      json({ activeWorkspaceId: ctx.settings().generation.activeWorkspaceId, workspaces: ctx.workspaces.list() }),
  }),

  tool({
    name: 'save_workspace',
    description:
      'Create or update a generation workspace. Omit id to create; pass id to update (only the fields you send change). ' +
      'pipeline "checkpoint" uses a single checkpoint (SD1.5/SDXL/Pony/Illustrious/NoobAI or all-in-one Flux); "flux" uses ' +
      'unet + clip1 + clip2 + vae; "custom" takes a ComfyUI API-format workflow with {{placeholders}}. Defaults, prefix and ' +
      'negative are filled from the base model family when omitted. Put always-on LoRAs in loras and situational ones in optional_loras ' +
      '(the local LLM decides when to use them based on their metadata).',
    schema: z.object({
      id: z.string().optional(),
      name: z.string(),
      description: z.string().optional(),
      base_model: baseModelEnum,
      pipeline: z.enum(['checkpoint', 'flux', 'custom']).optional(),
      checkpoint: z.string().optional(),
      unet: z.string().optional(),
      clip1: z.string().optional(),
      clip2: z.string().optional(),
      vae: z.string().optional(),
      loras: z.array(loraRef).optional(),
      optional_loras: z.array(loraRef).optional(),
      defaults: z
        .object({
          width: z.number().int(),
          height: z.number().int(),
          steps: z.number().int(),
          cfg: z.number(),
          sampler: z.string(),
          scheduler: z.string(),
          batchSize: z.number().int(),
          clipSkip: z.number().int(),
          guidance: z.number(),
        })
        .partial()
        .optional(),
      positive_prefix: z.string().optional(),
      negative_prompt: z.string().optional(),
      refiner_notes: z.string().optional().describe('Style guidance for the local prompt LLM (in English)'),
      custom_workflow: z.record(z.string(), z.unknown()).optional(),
      set_active: z.boolean().optional(),
    }),
    run: async (i, ctx) => {
      const existing = i.id ? ctx.workspaces.get(i.id) : undefined;
      const ws = await ctx.workspaces.save({
        id: i.id,
        name: i.name,
        description: i.description,
        baseModel: i.base_model,
        pipeline: i.pipeline,
        checkpoint: i.checkpoint,
        unet: i.unet,
        clip1: i.clip1,
        clip2: i.clip2,
        vae: i.vae,
        loras: i.loras,
        optionalLoras: i.optional_loras,
        defaults: i.defaults ? { ...(existing?.defaults ?? {}), ...i.defaults } as never : undefined,
        positivePrefix: i.positive_prefix,
        negativePrompt: i.negative_prompt,
        refinerNotes: i.refiner_notes,
        customWorkflow: i.custom_workflow,
      });
      if (i.set_active || ctx.workspaces.list().length === 1) await ctx.setActiveWorkspace(ws.id);

      // Warn about files that are not on disk (ComfyUI would reject the workflow).
      const missing: string[] = [];
      if (ctx.settings().comfy.rootPath) {
        const check = async (folders: ModelFolder[], file?: string) => {
          if (!file) return;
          for (const f of folders) if (await ctx.inventory.exists(f, file)) return;
          missing.push(`${folders.join('|')}/${file}`);
        };
        await check(['checkpoints'], ws.checkpoint);
        await check(['unet', 'diffusion_models'], ws.unet);
        await check(['clip', 'text_encoders'], ws.clip1);
        await check(['clip', 'text_encoders'], ws.clip2);
        await check(['vae'], ws.vae);
        for (const l of [...ws.loras, ...ws.optionalLoras]) await check(['loras'], l.file);
      }
      return json({ saved: ws, active: ctx.settings().generation.activeWorkspaceId === ws.id, missingFiles: missing });
    },
  }),

  tool({
    name: 'delete_workspace',
    description: 'Delete a generation workspace by id.',
    schema: z.object({ id: z.string() }),
    run: async ({ id }, ctx) => ((await ctx.workspaces.remove(id)) ? `Workspace ${id} deleted.` : `Workspace ${id} not found.`),
  }),

  tool({
    name: 'test_workspace',
    description:
      'Validate a workspace end-to-end by generating one image with a neutral, safe-for-work test prompt you choose ' +
      '(e.g. "a red apple on a wooden table, soft daylight"). Reports ComfyUI validation errors (missing nodes/files) and, ' +
      'by default, lets you look at a small preview of the result.',
    schema: z.object({
      id: z.string(),
      prompt: z.string(),
      steps: z.number().int().min(1).max(60).optional(),
      look_at_result: z.boolean().optional(),
    }),
    run: async ({ id, prompt, steps, look_at_result }, ctx) => {
      const ws = ctx.workspaces.get(id);
      if (!ws) throw new ToolError(`Workspace ${id} not found.`);
      const d = ws.defaults;
      const seed = randomSeed();
      const graph = buildWorkflow(ws, {
        positive: [ws.positivePrefix, prompt].filter(Boolean).join(', '),
        negative: ws.negativePrompt,
        width: d.width,
        height: d.height,
        steps: steps ?? d.steps,
        cfg: d.cfg,
        seed,
        batchSize: 1,
        sampler: d.sampler,
        scheduler: d.scheduler,
        guidance: d.guidance,
        clipSkip: d.clipSkip,
        loras: ws.loras,
        filenamePrefix: 'atelier_test',
      });
      const started = Date.now();
      const res = await ctx.comfy.run(graph, { signal: ctx.signal, timeoutMs: 15 * 60 * 1000 });
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      const outDir = join(ctx.settings().generation.outputDir, 'tests');
      await fs.mkdir(outDir, { recursive: true });
      const images: string[] = [];
      for (const ref of res.images) {
        const path = join(outDir, `${ws.id}_${seed}_${basename(ref.filename)}`);
        await fs.writeFile(path, await ctx.comfy.fetchImage(ref));
        images.push(path);
      }
      const summary = json({ ok: images.length > 0, seconds, seed, width: d.width, height: d.height, images });
      if (look_at_result === false || !images[0]) return summary;
      const preview = await ctx.previewImage(images[0]);
      if (!preview) return summary;
      return [
        { type: 'text', text: summary },
        { type: 'image', source: { type: 'base64', media_type: preview.mediaType, data: preview.data } },
      ];
    },
  }),
];

export type AnyTool = (typeof TOOLS)[number];

export function toolByName(name: string): AnyTool | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Tool definitions sent to the API. Built once so the tools prefix stays byte-identical (prompt caching). */
export const TOOL_PARAMS: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => {
  const schema = z.toJSONSchema(t.schema) as Record<string, unknown>;
  delete schema.$schema;
  return {
    name: t.name,
    description: t.description,
    input_schema: schema as Anthropic.Beta.BetaTool['input_schema'],
    eager_input_streaming: true,
  };
});
