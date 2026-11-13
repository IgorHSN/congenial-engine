import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SERVER_NAME = 'comfy-atelier';

export interface BridgeLaunch {
  /** Executable that runs the bridge (the app's own Electron binary in node mode). */
  command: string;
  bridgePath: string;
  dataDir: string;
}

export interface DesktopServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function desktopEntry(l: BridgeLaunch): DesktopServerEntry {
  return { command: l.command, args: [l.bridgePath, '--data-dir', l.dataDir], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** JSON users can paste into claude_desktop_config.json. */
export function desktopSnippet(l: BridgeLaunch): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: desktopEntry(l) } }, null, 2);
}

/** `claude mcp add` command for Claude Code (user scope: available in every project). */
export function claudeCodeCommand(l: BridgeLaunch): string {
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  return `claude mcp add ${SERVER_NAME} --scope user --env ELECTRON_RUN_AS_NODE=1 -- ${q(l.command)} ${q(l.bridgePath)} --data-dir ${q(l.dataDir)}`;
}

export function desktopConfigPath(platform = process.platform, env = process.env, home = homedir()): string {
  if (platform === 'win32') return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

/**
 * Add (or update) our server in Claude Desktop's config, keeping everything
 * else and saving a backup first. Refuses to touch a file that isn't valid JSON.
 */
export async function installInDesktopConfig(path: string, l: BridgeLaunch): Promise<{ backup: string | null; created: boolean }> {
  let config: Record<string, unknown> = {};
  let backup: string | null = null;
  const exists = existsSync(path);
  if (exists) {
    const raw = await fs.readFile(path, 'utf8');
    if (raw.trim()) {
      try {
        config = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new Error(`O arquivo ${path} não é um JSON válido; corrija-o ou cole a configuração manualmente.`);
      }
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`Formato inesperado em ${path}.`);
    }
    backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.copyFile(path, backup);
  }
  const servers = (config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}) as Record<string, unknown>;
  config.mcpServers = { ...servers, [SERVER_NAME]: desktopEntry(l) };
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { backup, created: !exists };
}
