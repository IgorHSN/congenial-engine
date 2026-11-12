import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { Settings } from '@shared/types';
import { detectComfyLayout } from './paths';

export type ProcState = 'stopped' | 'starting' | 'running' | 'exited';

/** Starts/stops a local ComfyUI process and keeps a rolling log. */
export class ComfyProcess {
  private child: ChildProcess | null = null;
  private logs: string[] = [];
  state: ProcState = 'stopped';
  private listeners = new Set<() => void>();

  constructor(private readonly getSettings: () => Settings) {}

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private log(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      this.logs.push(line);
      if (line.includes('To see the GUI go to') || line.includes('Starting server')) {
        if (this.state === 'starting') {
          this.state = 'running';
          this.emit();
        }
      }
    }
    if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
  }

  tail(lines = 200): string {
    return this.logs.slice(-lines).join('\n');
  }

  resolveLaunch(): { python: string; args: string[]; cwd: string } {
    const s = this.getSettings().comfy;
    const layout = detectComfyLayout(s.rootPath);
    if (!layout?.hasMainPy) {
      throw new Error('Configure a pasta do ComfyUI (a que contém main.py) nas configurações.');
    }
    const python = s.pythonPath || layout.python || (process.platform === 'win32' ? 'python' : 'python3');
    const url = new URL(s.url);
    const args = [join(layout.root, 'main.py'), '--listen', url.hostname, '--port', url.port || '8188'];
    if (layout.kind === 'portable') args.push('--windows-standalone-build');
    if (s.extraArgs.trim()) args.push(...splitArgs(s.extraArgs));
    return { python, args, cwd: layout.root };
  }

  start(): void {
    if (this.child) return;
    const { python, args, cwd } = this.resolveLaunch();
    this.logs.push(`> ${python} ${args.join(' ')}`);
    this.state = 'starting';
    this.emit();
    const child = spawn(python, args, { cwd, env: { ...process.env, PYTHONUNBUFFERED: '1' }, windowsHide: true });
    this.child = child;
    child.stdout?.on('data', (d) => this.log(d.toString()));
    child.stderr?.on('data', (d) => this.log(d.toString()));
    child.on('error', (err) => {
      this.log(`Falha ao iniciar: ${err.message}`);
      this.child = null;
      this.state = 'exited';
      this.emit();
    });
    child.on('exit', (code) => {
      this.log(`ComfyUI encerrou (código ${code}).`);
      this.child = null;
      this.state = 'exited';
      this.emit();
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 8000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      child.kill();
    });
    this.state = 'stopped';
    this.emit();
  }

  async restart(): Promise<void> {
    await this.stop();
    this.start();
  }

  get running(): boolean {
    return !!this.child;
  }
}

/** Split a command-line string into args, honouring simple quotes. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
