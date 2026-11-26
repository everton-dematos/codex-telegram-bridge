#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { Bridge } from '../lib/bridge.js';
import { ensureService, holdProject, localRequest } from '../lib/control.js';
import { configFile, runCodex, stateDir } from '../lib/local.js';
import { listen } from '../lib/server.js';
import { installSkill, setup } from '../lib/setup.js';
import { loadConfig, Outbox, pair, poll, Telegram } from '../lib/telegram.js';
import { Topics } from '../lib/topics.js';

const [action, ...args] = process.argv.slice(2);
try {
  if (action === 'setup') await setup();
  else if (action === 'install-skill') console.log(installSkill());
  else if (action === 'pair') await pair();
  else if (action === 'serve') {
    if (args.length && (args.length !== 2 || args[0] !== '--project')) throw new Error('Usage: codex-telegram serve --project PATH');
    await ensureService();
    await holdProject(realpathSync(args[1] || '.'));
  } else if (action === 'service') {
    const config = loadConfig();
    const api = new Telegram(config.token);
    const box = new Outbox(api, config.owner);
    const topics = new Topics(api, config.owner, config.token.split(':')[0], stateDir, box);
    const hub = new Bridge({ project: null, owner: config.owner, send: box.send.bind(box), topics,
      acknowledge: (id, text) => api.call('answerCallbackQuery', { callback_query_id: id, text }) });
    const cleanup = await listen(hub, process.env.CODEX_TELEGRAM_CODEX || 'codex');
    let busyAt = Date.now();
    const timer = setInterval(() => {
      hub.tick();
      if (hub.runs.mail.size || hub.projects.size || hub.sessions.size) busyAt = Date.now();
      else if (Date.now() - busyAt > 180000) stop();
    }, 30000);
    function stop() { cleanup(); clearInterval(timer); process.exit(0); }
    for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, stop);
    await poll(api, u => hub.update(u));
  } else if (action === 'cli') {
    await ensureService();
    const { path } = await localRequest({ op: 'endpoint', cwd: process.cwd() });
    runCodex(['--remote', 'unix://' + path, ...args]);
  } else if (['watch', 'notify', 'inbox', 'finish'].includes(action)) {
    const id = process.env.CODEX_THREAD_ID;
    if (!id) throw new Error('Run this command from the current Codex agent shell.');
    if (args.length > 1 || (action === 'finish' && args.length)) throw new Error('Pass message text or the run label as a single argument.');
    if (action === 'watch') await ensureService();
    const result = await localRequest({ op: action, id, cwd: process.cwd(),
      label: action === 'watch' ? args[0] : undefined, after: action === 'inbox' ? Number(args[0] || 0) : undefined,
      text: action === 'notify' ? args[0] : undefined });
    console.log(JSON.stringify(result));
  } else {
    console.log('Usage: codex-telegram setup | watch [LABEL] | notify TEXT | inbox [CURSOR] | finish | pair | install-skill | serve [--project PATH] | cli [CODEX_ARGS...]');
    if (action && action !== '--help' && action !== '-h') process.exitCode = 2;
  }
} catch (e) {
  console.error(e.code === 'ENOENT' && e.path === configFile ? 'Pair once on this workstation. In your own terminal run: ~/.local/bin/codex-telegram setup' : e.message);
  process.exitCode = 1;
}
