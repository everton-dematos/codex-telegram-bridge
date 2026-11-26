#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { WebSocket } from 'ws';
import { ensureService } from '../lib/control.js';
import { runCodex, socketPath } from '../lib/local.js';

const args = process.argv.slice(2);
const index = args.indexOf('app-server');
// Pass through ordinary CLI commands and app-server subcommands unchanged.
if (index < 0 || !args.slice(index + 1).every(a => a === '--analytics-default-enabled' || a === '--stdio')) {
  runCodex(args);
} else {
  try { await ensureService(); connectEditor(); }
  catch (e) {
    console.error('Telegram unavailable. Starting local Codex. ' + e.message);
    runCodex(args);
  }
}

function connectEditor() {
  const ws = new WebSocket('ws+unix://' + socketPath + ':/', {
    headers: {
      'x-codex-editor-args': Buffer.from(JSON.stringify(args)).toString('base64url'),
      'x-codex-editor-cwd': Buffer.from(process.cwd()).toString('base64url'),
    },
  });
  let connected = false;
  ws.on('open', () => {
    connected = true;
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on('line', line => {
      if (ws.readyState === WebSocket.OPEN) ws.send(line);
    });
    lines.on('close', () => ws.close());
    ws.on('close', () => { lines.close(); process.stdin.destroy(); });
  });
  ws.on('message', raw => { if (!process.stdout.write(raw.toString() + '\n')) ws.pause(); });
  process.stdout.on('drain', () => ws.resume());
  process.stdout.on('error', () => ws.terminate());
  ws.on('error', e => {
    if (!connected && ['ENOENT', 'ECONNREFUSED'].includes(e.code)) {
      console.error('Telegram bridge offline. Starting a local Codex session.');
      runCodex(args);
    } else { console.error('Telegram bridge connection failed:', e.message); process.exitCode = 1; }
  });
}
