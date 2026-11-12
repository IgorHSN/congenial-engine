import { spawn } from 'node:child_process';

export interface ProcResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Run a process, capturing combined stdout/stderr (tail only). */
export function runProcess(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; shell?: boolean; signal?: AbortSignal; maxOutput?: number } = {},
): Promise<ProcResult> {
  const maxOutput = opts.maxOutput ?? 12000;
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > maxOutput * 2) output = output.slice(-maxOutput);
    };
    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        shell: opts.shell ?? false,
        env: { ...process.env, PYTHONUNBUFFERED: '1', GIT_TERMINAL_PROMPT: '0' },
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: -1, output: (err as Error).message, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs ?? 10 * 60 * 1000);
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => {
      output += `\n${err.message}`;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, output: output.slice(-maxOutput), timedOut });
    });
  });
}
