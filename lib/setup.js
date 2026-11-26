import { lstatSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, pair } from './telegram.js';

export function installSkill() {
  const source = fileURLToPath(new URL('../skills/telegram-notify', import.meta.url));
  const dir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills');
  const destination = join(dir, 'telegram-notify');
  mkdirSync(dir, { recursive: true });
  try {
    lstatSync(destination);
    if (realpathSync(destination) !== realpathSync(source)) throw new Error('A different skill already exists at ' + destination);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    symlinkSync(source, destination, 'dir');
  }
  return destination;
}

export async function setup() {
  console.log('Codex skill: ' + installSkill());
  try { loadConfig(); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    console.log('Open https://t.me/BotFather and send /newbot. Choose a name, then copy your personal bot token.');
    await pair();
  }
  console.log('Ready. From your project terminal, run ~/.local/bin/codex-telegram cli and enter your task. Keep the CLI open for phone replies.');
}
