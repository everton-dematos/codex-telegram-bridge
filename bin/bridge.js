#!/usr/bin/env node
import { realpathSync, statSync } from 'node:fs';
import { Bridge } from '../lib/bridge.js';
import { configFile, runCodex, socketPath } from '../lib/local.js';
import { listen } from '../lib/server.js';
import { loadConfig, Outbox, pair, poll, Telegram } from '../lib/telegram.js';

const [action, ...args] = process.argv.slice(2);
try {
  if (action === 'pair') {
    await pair();
  } else if (action === 'serve') {
    if (args.length && (args.length !== 2 || args[0] !== '--project')) throw new Error('Usage: codex-telegram serve --project PATH');
    const project = realpathSync(args[1] || '.');
    if (!statSync(project).isDirectory()) throw new Error('Select a project directory.');
    const config = loadConfig();
    const api = new Telegram(config.token);
    const box = new Outbox(api, config.owner);
    const hub = new Bridge({ project, owner: config.owner, send: box.send.bind(box),
      acknowledge: (id, text) => api.call('answerCallbackQuery', { callback_query_id: id, text }) });
    const cleanup = await listen(hub, process.env.CODEX_TELEGRAM_CODEX || 'codex');
    const timer = setInterval(() => hub.tick(), 30000);
    const stop = () => { cleanup(); clearInterval(timer); };
    for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { stop(); process.exit(0); });
    console.log('Listening on ' + socketPath + '\nForwarding Codex threads rooted at ' + project);
    hub.post('Bridge online for ' + project + '. Start Codex in that project and send /status to check it.');
    try { await poll(api, u => hub.update(u)); } finally { stop(); }
  } else if (action === 'cli') {
    runCodex(['--remote', 'unix://' + socketPath, ...args]);
  } else {
    console.log('Usage: codex-telegram pair | serve [--project PATH] | cli [CODEX_ARGS...]\nPair prompts for your private bot token. Credentials: ' + configFile);
    if (action && action !== '--help' && action !== '-h') process.exitCode = 2;
  }
} catch (e) {
  console.error(e.code === 'ENOENT' && e.path === configFile ? 'Run codex-telegram pair first.' : e.message);
  process.exitCode = 1;
}
