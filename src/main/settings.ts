import { join } from 'node:path';
import type { DeepPartial, PublicSettings, SecretName, Settings } from '@shared/types';
import { JsonFile } from './store';

export interface SecretCodec {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
}

type SecretsFile = Partial<Record<SecretName, { enc: boolean; value: string }>>;

export function defaultSettings(picturesDir: string): Settings {
  return {
    comfy: {
      url: 'http://127.0.0.1:8188',
      rootPath: '',
      pythonPath: '',
      extraArgs: '',
      manageProcess: false,
      autoStart: false,
    },
    claude: {
      model: 'claude-opus-5-5',
      effort: 'medium',
      autoApproveDownloads: false,
    },
    localLlm: {
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: '',
      temperature: 0.8,
      keepAlive: '0',
    },
    generation: {
      outputDir: join(picturesDir, 'Comfy Atelier'),
      activeWorkspaceId: null,
      showRefinedPrompt: true,
    },
    mcp: {
      enabled: true,
    },
  };
}

function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = out[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      out[key] = deepMerge(current, value as DeepPartial<typeof current>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/**
 * Settings live in settings.json; API keys and tokens live in secrets.json,
 * encrypted with the OS keychain (Electron safeStorage) when available.
 */
export class SettingsStore {
  private settings!: Settings;
  private secrets: SecretsFile = {};
  private readonly settingsFile: JsonFile<DeepPartial<Settings>>;
  private readonly secretsFile: JsonFile<SecretsFile>;
  private listeners = new Set<(s: Settings) => void>();

  constructor(
    dataDir: string,
    private readonly defaults: Settings,
    private readonly codec: SecretCodec,
  ) {
    this.settingsFile = new JsonFile(join(dataDir, 'settings.json'), () => ({}));
    this.secretsFile = new JsonFile(join(dataDir, 'secrets.json'), () => ({}));
  }

  async load(): Promise<void> {
    this.settings = deepMerge(this.defaults, await this.settingsFile.read());
    this.secrets = await this.secretsFile.read();
  }

  get(): Settings {
    return this.settings;
  }

  getPublic(): PublicSettings {
    return {
      ...this.settings,
      secrets: {
        anthropicApiKey: !!this.getSecret('anthropicApiKey'),
        civitaiToken: !!this.getSecret('civitaiToken'),
        huggingfaceToken: !!this.getSecret('huggingfaceToken'),
      },
    };
  }

  async update(patch: DeepPartial<Settings>): Promise<Settings> {
    this.settings = deepMerge(this.settings, patch);
    await this.settingsFile.write(this.settings);
    for (const l of this.listeners) l(this.settings);
    return this.settings;
  }

  onChange(listener: (s: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSecret(name: SecretName): string | undefined {
    const envFallback: Partial<Record<SecretName, string | undefined>> = {
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      civitaiToken: process.env.CIVITAI_TOKEN,
      huggingfaceToken: process.env.HF_TOKEN,
    };
    const entry = this.secrets[name];
    if (!entry) return envFallback[name] || undefined;
    try {
      return entry.enc ? this.codec.decrypt(entry.value) : entry.value;
    } catch {
      return undefined;
    }
  }

  async setSecret(name: SecretName, value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) {
      delete this.secrets[name];
    } else if (this.codec.isAvailable()) {
      this.secrets[name] = { enc: true, value: this.codec.encrypt(trimmed) };
    } else {
      this.secrets[name] = { enc: false, value: trimmed };
    }
    await this.secretsFile.write(this.secrets);
    for (const l of this.listeners) l(this.settings);
  }
}
