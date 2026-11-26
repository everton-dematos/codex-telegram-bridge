import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { lstatSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { WebSocket, WebSocketServer } from 'ws';
import { Session } from './bridge.js';
import { privateDirectory, runDir, secureSocket, socketPath } from './local.js';

async function prepareSocket() {
  privateDirectory(runDir);
  let st;
  try { st = lstatSync(socketPath); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!st.isSocket() || st.uid !== process.getuid()) throw new Error('Unexpected file at ' + socketPath);
  // Never remove the socket of a running service.
  await new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath);
    s.on('connect', () => { s.destroy(); reject(new Error('A bridge is already running.')); });
    s.on('error', e => {
      if (e.code === 'ECONNREFUSED') {
        try { if (lstatSync(socketPath).ino === st.ino) unlinkSync(socketPath); resolve(); } catch (err) { reject(err); }
      } else if (e.code === 'ENOENT') resolve();
      else reject(e);
    });
  });
}

// Each local client keeps its own app-server process and JSON-RPC request namespace.
function connect(ws, req, hub, binary) {
  let args = ['app-server'];
  try {
    const header = req.headers['x-codex-editor-args'];
    if (header) {
      args = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      if (!Array.isArray(args) || !args.includes('app-server') || !args.every(v => typeof v === 'string')) throw new Error();
    }
  } catch { ws.close(1008, 'Invalid editor arguments'); return; }
  const env = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN;
  const cwd = req.headers['x-codex-editor-cwd'] ? Buffer.from(req.headers['x-codex-editor-cwd'], 'base64url').toString() : hub.project;
  const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const session = new Session(hub, (m, raw) => {
    if (!child.stdin.destroyed && !child.stdin.write((raw ?? JSON.stringify(m)) + '\n')) ws.pause();
  }, (m, raw) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(raw ?? JSON.stringify(m), err => { if (err) ws.terminate(); });
    if (ws.bufferedAmount > 32 * 1024 * 1024) ws.terminate();
  });
  child.stdin.on('drain', () => ws.resume());
  child.stdin.on('error', () => ws.terminate());
  child.on('error', e => { console.error('Codex launch failed:', e.message); ws.terminate(); });
  child.on('close', () => ws.close(1001, 'Codex exited'));
  ws.on('message', raw => {
    try { const s = raw.toString(); session.client(JSON.parse(s), s); }
    catch { ws.close(1007, 'Invalid client message'); }
  });
  lines.on('line', raw => {
    try { session.server(JSON.parse(raw), raw); }
    catch (e) { console.error('Codex protocol error:', e.message); ws.close(1011, 'Invalid Codex message'); }
  });
  ws.on('error', () => ws.terminate());
  ws.on('close', () => {
    session.close(); lines.close(); child.stdin.end(); child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
    timer.unref();
  });
}

export async function listen(hub, binary) {
  await prepareSocket();
  const server = http.createServer((_, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.origin) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => connect(ws, req, hub, binary));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  secureSocket();
  return () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close(); server.close();
  };
}
