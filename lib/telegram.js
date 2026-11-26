import { randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { configFile, privateDirectory, stateDir } from './local.js';

export class Telegram {
  constructor(token) {
    if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid Telegram bot token.');
    this.token = token;
  }
  async call(method, data) {
    const res = await fetch('https://api.telegram.org/bot' + this.token + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(45000),
    });
    const result = await res.json();
    if (!result.ok) {
      const error = new Error('Telegram ' + method + ' returned ' + result.error_code + ': ' + result.description);
      error.retry = result.parameters?.retry_after;
      error.status = result.error_code;
      throw error;
    }
    return result.result;
  }
  updates(offset, timeout = 25) {
    return this.call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] });
  }
}

export function privateSender(message, sender) {
  return message?.chat?.type === 'private' && Number.isSafeInteger(sender?.id)
    && !sender.is_bot && sender.id === message.chat.id;
}

export function loadConfig() {
  const st = lstatSync(configFile);
  if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077)) throw new Error('Expected a private bot.json (chmod 600).');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  if (!Number.isSafeInteger(config.owner) || config.owner <= 0) throw new Error('Pair your Telegram account again.');
  return config;
}

async function readToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  if (!process.stdin.isTTY) throw new Error('Pair from a terminal or supply TELEGRAM_BOT_TOKEN.');
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
  process.stderr.write('Paste the token from @BotFather (hidden): ');
  try { return (await rl.question('')).trim(); }
  finally { rl.close(); process.stderr.write('\n'); }
}

export async function pair() {
  const api = new Telegram(await readToken());
  privateDirectory(stateDir);
  const me = await api.call('getMe', {});
  const challenge = randomBytes(20).toString('hex');
  console.log('On your phone open https://t.me/' + me.username + '?start=' + challenge + ' and tap Start. This link expires in five minutes. Keep it private.');
  const deadline = Date.now() + 300000;
  let offset;
  while (Date.now() < deadline) {
    for (const u of await api.updates(offset, 10)) {
      offset = u.update_id + 1;
      const m = u.message;
      if (Date.now() >= deadline || !privateSender(m, m?.from) || m.text !== '/start ' + challenge) continue;
      const tmp = join(stateDir, randomUUID() + '.tmp');
      writeFileSync(tmp, JSON.stringify({ token: api.token, owner: m.from.id }) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(tmp, configFile);
      console.log('Paired with Telegram user ' + m.from.id + '. Credentials saved at ' + configFile);
      return;
    }
  }
  throw new Error('Pairing expired. Run pair again.');
}

export async function poll(api, handle) {
  let offset;
  let failures = 0;
  for (;;) {
    try {
      for (const update of await api.updates(offset)) {
        await handle(update);
        offset = update.update_id + 1;
      }
      failures = 0;
    } catch (e) {
      console.error('Telegram update error:', e.message);
      const authOrConflict = e.status === 401 || e.status === 409;
      await delay(1000 * (e.retry || (authOrConflict ? 60 : Math.min(30, 2 ** ++failures))));
    }
  }
}

// Keep message order and let local Codex continue while Telegram is unavailable.
export class Outbox {
  constructor(api, owner) { this.api = api; this.owner = owner; this.tail = Promise.resolve(); }
  send(text, options = {}) {
    const job = async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.api.call('sendMessage', { chat_id: this.owner, text, link_preview_options: { is_disabled: true }, ...options });
        } catch (e) {
          if (attempt >= 3 || (e.status && e.status < 500 && e.status !== 429)) throw e;
          await delay(1000 * (e.retry || 2 ** attempt));
        }
      }
    };
    const result = this.tail.then(job);
    this.tail = result.catch(e => console.error('Telegram delivery failed:', e.message));
    return result;
  }
}
