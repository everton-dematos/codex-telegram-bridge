import http from 'node:http';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { ensureService, localRequest } from './control.js';
import { isUserConversation, runCodex, runDir } from './local.js';

// A listener from before automatic forwarding can still be serving other live
// clients during an upgrade. Attach only threads opened by this CLI connection.
async function legacyEndpoint(upstreamPath) {
  const dir = mkdtempSync(join(runDir, 'cli-'));
  const path = join(dir, 's');
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.origin) { socket.destroy(); return; }
    const upstream = new WebSocket('ws+unix://' + upstreamPath + ':/');
    socket.pause();
    let client;
    upstream.on('error', () => { socket.destroy(); client?.terminate(); });
    socket.on('error', () => upstream.terminate());
    socket.once('close', () => upstream.terminate());
    upstream.on('open', () => wss.handleUpgrade(req, socket, head, ws => {
      client = ws;
      const opens = new Set();
      const attached = new Set();
      ws.on('message', raw => {
        const text = raw.toString();
        let m;
        try { m = JSON.parse(text); } catch { ws.close(1007, 'Invalid RPC message'); return; }
        if (['thread/start', 'thread/resume', 'thread/fork'].includes(m.method)) opens.add(m.id);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
      });
      upstream.on('message', raw => {
        const text = raw.toString();
        let m;
        try { m = JSON.parse(text); } catch { ws.close(1007, 'Invalid RPC message'); return; }
        if (!m.method && opens.delete(m.id)) {
          const thread = m.result?.thread;
          const id = thread?.id;
          if (isUserConversation(thread) && !attached.has(id)) {
            attached.add(id);
            localRequest({ op: 'watch', id }).catch(e => console.error('Could not enable Telegram:', e.message));
          }
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      });
      ws.on('error', () => upstream.terminate());
      upstream.on('close', () => ws.terminate());
      socket.resume();
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  return { path, close() {
    for (const client of wss.clients) client.terminate();
    wss.close(); server.close(() => rmdirSync(dir));
  } };
}

export async function launchCli(args) {
  await ensureService();
  const endpoint = await localRequest({ op: 'endpoint', cwd: process.cwd() });
  const transport = endpoint.autoWatch ? endpoint : await legacyEndpoint(endpoint.path);
  runCodex(['--remote', 'unix://' + transport.path, ...args], transport.close);
}
