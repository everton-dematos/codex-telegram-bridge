import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export const stateDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'codex-telegram-bridge');
export const configFile = join(stateDir, 'bot.json');
export const runDir = join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'codex-telegram-' + process.getuid());
export const socketPath = join(runDir, 'bridge.sock');

export function privateDirectory(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) {
    throw new Error('Expected a private directory owned by you (mode 0700): ' + dir);
  }
}

export function projectPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  try { return realpathSync(path); } catch { return null; }
}

export function isUserConversation(thread) {
  if (!thread?.id || thread.parentThreadId || thread.source?.subAgent) return false;
  // Older app servers omit threadSource. Title generation also uses a thread
  // but its ephemeral result is internal to the client.
  return thread.threadSource == null ? !thread.ephemeral : thread.threadSource === 'user';
}

export function runCodex(args, onClose) {
  const child = spawn(process.env.CODEX_TELEGRAM_CODEX || 'codex', args, { stdio: 'inherit' });
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('error', e => { console.error(e.message); process.exitCode = 1; });
  if (onClose) child.once('close', onClose);
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
}
