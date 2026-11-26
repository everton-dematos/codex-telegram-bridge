// Exercise both native front-end transports with a local Responses API fixture.
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'ct-smoke-'));
const project = join(root, 'project');
mkdirSync(project);
const codexDir = join(root, 'config');
mkdirSync(codexDir);
process.env.CODEX_HOME = codexDir;
process.env.XDG_RUNTIME_DIR = root;
const { Bridge } = await import('../lib/bridge.js');
const { Topics } = await import('../lib/topics.js');
const { listen } = await import('../lib/server.js');
const binary = process.env.CODEX_TELEGRAM_CODEX || 'codex';
let issueCommand = true;
const mock = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const followUp = Buffer.concat(chunks).toString().includes('How about Strasbourg?');
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const id = 'resp_' + Date.now();
  const push = (type, fields) => res.write('data: ' + JSON.stringify({ type, ...fields }) + '\n\n');
  push('response.created', { response: { id, status: 'in_progress' } });
  let item;
  if (issueCommand) {
    issueCommand = false;
    item = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'pwd', sandbox_permissions: 'require_escalated', justification: 'Test the approval prompt for pwd?' }) };
  } else {
    item = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: followUp ? 'Strasbourg follow-up received.' : 'Offline smoke test complete.' }] };
  }
  push('response.output_item.added', { output_index: 0, item });
  push('response.output_item.done', { output_index: 0, item });
  push('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } });
  res.end();
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
writeFileSync(join(codexDir, 'config.toml'), [
  'model = "gpt-5.4"', 'model_provider = "fixture"', 'approval_policy = "on-request"', 'approvals_reviewer = "user"',
  '[model_providers.fixture]', 'name = "Offline fixture"', 'wire_api = "responses"',
  'base_url = "http://127.0.0.1:' + mock.address().port + '/v1"', 'supports_websockets = false',
].join('\n'));

const notes = [];
let topicSequence = 500;
const outbox = { send: async (text, options) => {
  notes.push({ text, ...options });
  return { message_id: notes.length };
} };
const topics = new Topics({ call: async method => method === 'createForumTopic' ? { message_thread_id: ++topicSequence } : true }, 123, '1', root, outbox);
const hub = new Bridge({ project: null, owner: 123, topics, send: outbox.send, acknowledge: async () => {} });
const launcher = fileURLToPath(new URL('../bin/bridge.js', import.meta.url));
async function runHelper(id, args) {
  const result = await promisify(execFile)(process.execPath, [launcher, ...args], { cwd: project, env: { ...process.env, CODEX_THREAD_ID: id } });
  return JSON.parse(result.stdout);
}
const cleanup = await listen(hub, binary);
async function until(condition) {
  const deadline = Date.now() + 20000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out. Phone messages: ' + JSON.stringify(notes));
    await delay(25);
  }
}
async function smokeEditor(args, approve) {
  notes.length = 0;
  issueCommand = true;
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'inherit'], cwd: project });
  const lines = createInterface({ input: child.stdout });
  const wire = [];
  lines.on('line', line => wire.push(JSON.parse(line)));
  const send = m => child.stdin.write(JSON.stringify(m) + '\n');
  async function call(id, method, params) {
    send({ id, method, params });
    await until(() => wire.some(m => m.id === id && !m.method));
    const m = wire.find(m => m.id === id && !m.method);
    assert.equal(m.error, undefined, JSON.stringify(m.error));
    return m.result;
  }
  try {
    await call(1000, 'initialize', { clientInfo: { name: 'bridge-smoke', version: '1.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const { thread } = await call(1001, 'thread/start', { cwd: project, modelProvider: 'fixture', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    await call(1002, 'turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Test approval transport.' }] });
    await until(() => wire.some(m => m.method === 'item/commandExecution/requestApproval'));
    assert.equal((await runHelper(thread.id, ['watch', 'Editor smoke'])).mode, 'native');
    await until(() => notes.some(m => m.reply_markup));
    const idx = notes.findIndex(m => m.reply_markup);
    const request = wire.find(m => m.method === 'item/commandExecution/requestApproval');
    assert.equal(request.params.threadId, thread.id);
    assert.match(request.params.command, /^(?:[^\s]+ -lc )?pwd$/);
    assert.equal(request.params.cwd, project);
    // Steering and decision travel over the exact same connection as the local UI.
    const topic = topics.entries.get(thread.id).topic;
    await hub.update({ message: { text: 'Finish after this check.', chat: { id: 123, type: 'private' }, from: { id: 123 }, message_thread_id: topic } });
    await until(() => notes.some(m => m.text.includes('received your instruction')));
    await hub.update({ callback_query: { id: 'cb', data: notes[idx].reply_markup.inline_keyboard[0][approve ? 0 : 1].callback_data,
      from: { id: 123 }, message: { message_id: idx + 1, message_thread_id: topic, chat: { id: 123, type: 'private' } } } });
    await until(() => wire.some(m => m.method === 'turn/completed'));
    assert.ok(wire.some(m => m.method === 'serverRequest/resolved' && m.params.requestId === request.id));
    if (approve) {
      const execution = wire.find(m => m.method === 'item/completed' && m.params.item.type === 'commandExecution');
      assert.equal(execution?.params.item.exitCode, 0, JSON.stringify(execution));
    }
    if (!notes.some(m => m.text.includes('Offline smoke test complete.'))) {
      const last = notes.findLastIndex(m => m.text.includes('Turn '));
      assert.ok(last >= 0);
      await hub.update({ message: { text: 'Conclude the test.', from: { id: 123 }, chat: { id: 123, type: 'private' }, message_thread_id: topic, reply_to_message: { message_id: last + 1 } } });
      await until(() => notes.some(m => m.text.includes('Offline smoke test complete.')));
    }
    console.log('Passed VS Code stdio adapter: start, steer, ' + (approve ? 'approve pwd' : 'reject pwd') + ', resolve, complete.');
  } finally {
    child.stdin.end();
    child.kill();
    lines.close();
  }
}
async function smokeInteractive(resumeId, env = process.env) {
  if (spawnSync('tmux', ['-V']).status !== 0) return;
  const topicSocket = join(root, resumeId ? 'tmux-resume.sock' : 'tmux.sock');
  const tmux = (...args) => promisify(execFile)('tmux', ['-f', '/dev/null', '-S', topicSocket, ...args], { cwd: project, env });
  notes.length = 0;
  issueCommand = false;
  const args = resumeId ? ['resume', resumeId] : ['Check Colmar.'];
  await tmux('new-session', '-d', '-x', '120', '-y', '36', '-s', 'test', process.execPath, launcher, 'cli', ...args);
  try {
    await until(() => notes.some(n => n.text.includes(resumeId ? 'Connected to your Codex CLI' : 'Turn completed.')));
    const idx = notes.findIndex(n => n.text.includes(resumeId ? 'Connected to your Codex CLI' : 'Offline smoke test complete.'));
    const topic = notes[idx].message_thread_id;
    if (resumeId) {
      const saved = topics.entries.get(resumeId);
      assert.equal(saved.topic, topic);
      assert.ok(notes[idx].text.startsWith('[' + saved.name + ']'));
    }
    await hub.update({ message: { message_id: 950, from: { id: 123 }, chat: { id: 123, type: 'private' },
      message_thread_id: topic, ...(resumeId ? {} : { reply_to_message: { message_id: idx + 1 } }), text: 'How about Strasbourg?' } });
    await until(() => notes.some(n => n.text.includes('Strasbourg follow-up received.')));
    const deadline = Date.now() + 5000;
    let pane;
    do {
      await delay(100);
      pane = (await tmux('capture-pane', '-p', '-S', '-100', '-t', 'test')).stdout;
    } while (!pane.includes('Strasbourg follow-up received.') && Date.now() < deadline);
    assert.ok(pane.includes('Strasbourg follow-up received.'), 'The follow-up response should appear in the original CLI.');
    console.log('Passed interactive CLI: ' + (resumeId ? 'resume existing topic' : 'normal prompt') + ', idle phone reply, visible response in the same terminal.');
  } finally { await tmux('kill-server').catch(() => {}); }
}
async function smokeUpgrade() {
  if (spawnSync('tmux', ['-V']).status !== 0) return;
  const previous = join(root, 'previous');
  const runName = 'codex-telegram-' + process.getuid();
  mkdirSync(join(previous, runName), { recursive: true, mode: 0o700 });
  const watches = [];
  // The previous release supplies a socket path and an explicit per-thread
  // watch operation. It can still have live clients when the CLI is upgraded.
  const old = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks));
    let result;
    if (data.op === 'ping') result = { ready: true };
    else if (data.op === 'endpoint') result = { path: join(root, runName, 'bridge.sock') };
    else if (data.op === 'watch') {
      watches.push(data.id);
      result = await hub.runs.action(data);
    }
    res.end(JSON.stringify(result));
  });
  old.listen(join(previous, runName, 'bridge.sock'));
  await once(old, 'listening');
  try {
    await smokeInteractive(undefined, { ...process.env, XDG_RUNTIME_DIR: previous });
    assert.equal(watches.length, 1);
    console.log('Passed upgrade with an existing listener and no agent-issued watch command.');
  } finally { old.closeAllConnections(); old.close(); }
}
try {
  issueCommand = false;
  const cli = spawn(process.execPath, [fileURLToPath(new URL('../bin/bridge.js', import.meta.url)), 'cli', 'exec',
    '--json', 'Test the local Codex transport.'], { cwd: project, stdio: ['ignore', 'pipe', 'inherit'] });
  const done = once(cli, 'exit');
  cli.stdout.resume();
  const timer = setTimeout(() => cli.kill(), 25000);
  try {
    const [code] = await done;
    assert.equal(code, 0);
    assert.ok(notes.some(n => n.text.includes('Offline smoke test complete.')), JSON.stringify(notes));
    console.log('Passed native Codex CLI: start, notification, completion.');
  } finally { clearTimeout(timer); }
  const [resumeId] = topics.entries.keys();
  await smokeInteractive();
  // Reproduce an ordinary helper-based session with a named topic. The old
  // CLI may have exited before its finish helper reached the local socket.
  const registration = await runHelper(resumeId, ['watch', 'Release tests']);
  assert.equal(registration.mode, 'agent');
  assert.equal(registration.resumeCommand, '~/.local/bin/codex-telegram cli resume ' + resumeId);
  const savedTopic = topics.entries.get(resumeId).topic;
  await smokeInteractive(resumeId);
  assert.equal(topics.entries.get(resumeId).topic, savedTopic);
  assert.equal(topics.entries.get(resumeId).label, 'Release tests');
  await smokeUpgrade();
  const ordinary = '76543210-0000-4000-a000-000000000000';
  assert.equal((await runHelper(ordinary, ['watch', 'Existing CLI'])).mode, 'agent');
  await runHelper(ordinary, ['notify', 'Build finished']);
  await hub.update({ message: { message_id: 990, message_thread_id: topics.entries.get(ordinary).topic, from: { id: 123 }, chat: { id: 123, type: 'private' }, text: 'Check CI' } });
  assert.deepEqual((await runHelper(ordinary, ['inbox'])).replies, [{ id: 990, text: 'Check CI' }]);
  await runHelper(ordinary, ['finish']);
  console.log('Passed ordinary run helpers: topic, notification, reply, finish.');
  const editorArgs = [fileURLToPath(new URL('../bin/editor.js', import.meta.url)), '-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'];
  await smokeEditor(editorArgs, false);
  await smokeEditor(editorArgs, true);
} finally {
  cleanup();
  mock.closeAllConnections();
  mock.close();
  await delay(500);
  rmSync(root, { recursive: true, force: true });
}
