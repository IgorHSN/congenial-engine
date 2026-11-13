/**
 * Entry point Claude Desktop / Claude Code run (with ELECTRON_RUN_AS_NODE=1 or
 * plain node): `bridge.js --data-dir <Comfy Atelier data folder>`.
 * Speaks MCP on stdin/stdout; logs go to stderr only.
 */
import { createInterface } from 'node:readline';
import { createBridge } from './bridge';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const dataDir = arg('--data-dir');
if (!dataDir) {
  process.stderr.write('comfy-atelier MCP bridge: missing --data-dir <path>\n');
  process.exit(2);
}

const bridge = createBridge({
  dataDir,
  version: arg('--version') ?? '0.1.0',
  write: (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`),
});

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  void bridge.handleLine(line).catch((err) => process.stderr.write(`bridge error: ${String(err)}\n`));
});
rl.on('close', () => {
  bridge.close();
  process.exit(0);
});
