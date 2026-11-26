import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateDirectory, projectPath, runDir, socketPath } from './local.js';
import { loadConfig } from './telegram.js';

export function localRequest(data) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/run', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', part => { body += part; });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(body);
          if (res.statusCode !== 200) throw new Error(value.error || 'Local bridge request failed.');
          resolve(value);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('The bridge timed out. Verify Telegram delivery.')));
    req.end(JSON.stringify(data));
  });
}

export async function ensureService() {
  const ping = () => localRequest({ op: 'ping' });
  try { return await ping(); } catch (e) { if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e; }
  loadConfig(); // Report missing pairing in the foreground before spawning.
  privateDirectory(runDir);
  const log = openSync(join(runDir, 'service.log'), 'a', 0o600);
  let error;
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/bridge.js', import.meta.url)), 'service'], {
      detached: true, stdio: ['ignore', log, log],
    });
    child.once('error', e => { error = e; });
    child.unref();
  } finally { closeSync(log); }
  for (let i = 0; i < 60; i++) {
    if (error) throw error;
    await delay(100);
    try { return await ping(); } catch (e) { if (!['ENOENT', 'ECONNREFUSED'].includes(e.code)) throw e; }
  }
  throw new Error('Could not start the local bridge. See ' + join(runDir, 'service.log'));
}

export function holdProject(cwd) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/run', method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      res.setEncoding('utf8');
      res.on('data', data => process.stdout.write(data));
      res.on('error', reject);
      res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('Project monitoring failed.')));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ op: 'project', cwd }));
  });
}

export async function handleControl(hub, req, res, cliEndpoint) {
  if (req.method !== 'POST' || req.url !== '/run' || req.headers.origin || req.headers['content-type'] !== 'application/json') {
    res.writeHead(404); res.end(); return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 32768) throw new Error('Request too large.');
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (data.op === 'project') {
      const cwd = projectPath(data.cwd);
      if (!cwd) throw new Error('Choose an existing project directory.');
      hub.projects.set(cwd, (hub.projects.get(cwd) || 0) + 1);
      const update = () => {
        for (const session of hub.sessions) for (const thread of session.threads.values()) {
          if (thread.cwd === cwd) thread.watched = thread.optIn || hub.projects.has(cwd) || hub.project === cwd;
        }
      };
      update();
      res.on('close', () => {
        const n = hub.projects.get(cwd) - 1;
        if (n) hub.projects.set(cwd, n); else hub.projects.delete(cwd);
        update();
      });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('Forwarding Codex threads in ' + cwd + '\n');
      hub.post('Bridge online for ' + cwd + '. Each connected session will get its own topic.');
      return;
    }
    let result;
    if (data.op === 'ping') result = { ready: true };
    else if (data.op === 'endpoint') result = { path: await cliEndpoint(data.cwd) };
    else result = await hub.runs.action(data);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })); }
}
