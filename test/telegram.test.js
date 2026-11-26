import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('pair requires the terminal challenge in a matching private chat, stores private credentials, and sends Bot API parameters', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-pair-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.XDG_CONFIG_HOME = dir;
  process.env.TELEGRAM_BOT_TOKEN = '777:fixture';
  const { pair, loadConfig, Outbox, Telegram } = await import('../lib/telegram.js');
  const calls = [];
  let start;
  t.mock.method(console, 'log', line => {
    const found = /\?start=([a-f0-9]{40})/.exec(line);
    if (found) start = '/start ' + found[1];
  });
  const message = (text, type, chat, from, id) => ({
    update_id: id, message: { text, chat: { type, id: chat }, from: { id: from } },
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const method = url.split('/').pop();
    const data = JSON.parse(options.body);
    calls.push([method, data]);
    const results = {
      getMe: { username: 'test_bot' },
      getUpdates: [
        message('/start wrong', 'private', 999, 999, 1),
        message(start, 'group', 999, 999, 2),
        message(start, 'private', 999, 321, 3),
        message(start, 'private', 123, 123, 4),
      ],
      sendMessage: { message_id: 10 },
    };
    return { json: async () => ({ ok: true, result: results[method] }) };
  });
  await pair();
  const { configFile } = await import('../lib/local.js');
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
  assert.deepEqual(loadConfig(), { owner: 123, token: '777:fixture' });
  const box = new Outbox(new Telegram('777:fixture'), 123);
  const options = { reply_markup: { inline_keyboard: [[{ text: 'Approve once', callback_data: 'allow.fixture' }]] } };
  assert.deepEqual(await box.send('Review pwd', options), { message_id: 10 });
  assert.deepEqual(calls.at(-1), ['sendMessage', { chat_id: 123, text: 'Review pwd', link_preview_options: { is_disabled: true }, ...options }]);
});
