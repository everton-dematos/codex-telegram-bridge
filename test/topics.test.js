import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Bridge, Session } from '../lib/bridge.js';
import { Topics } from '../lib/topics.js';

const one = '019affe0-ffff-7777-ab00-000000000001';
const two = '019affe0-ffff-7777-ab00-000000000002';
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'topics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let sequence = 20;
  const calls = [], sent = [], dead = new Set();
  const api = { async call(method, data) {
    calls.push({ method, ...data });
    if (method === 'createForumTopic') return { message_thread_id: ++sequence };
    return true;
  } };
  const box = { async send(text, options = {}) {
    if (dead.has(options.message_thread_id)) throw Object.assign(new Error('message thread not found'), { status: 400 });
    const m = { message_id: ++sequence, text, ...options };
    sent.push(m); return m;
  } };
  const topics = new Topics(api, 42, '1', dir, box);
  const hub = new Bridge({ owner: 42, project: null, send: box.send, acknowledge: async () => {}, topics });
  const message = (topic, text, id, extra = {}) => hub.update({ message: {
    chat: { type: 'private', id: 42 }, from: { id: 42 }, message_id: id, message_thread_id: topic, text, ...extra,
  } });
  return { dir, api, box, topics, hub, calls, sent, dead, message };
}

test('parallel ordinary agents with identical labels get separate topics and independently readable replies', async t => {
  const f = fixture(t);
  const watch = id => f.hub.runs.action({ op: 'watch', id, cwd: '/work', label: 'Release' });
  await Promise.all([watch(one), watch(two)]);
  const [a,b] = [one,two].map(id => f.topics.entries.get(id));
  assert.notEqual(a.topic, b.topic);
  assert.notEqual(a.name, b.name);
  assert.equal(f.calls.filter(x => x.method === 'setMySettings').length, 1);
  await f.message(a.topic, 'first', 101);
  await f.message(b.topic, 'second', 102, { reply_to_message: { message_id: b.topic, forum_topic_created: {} } });
  const query = (id, after) => f.hub.runs.action({ op: 'inbox', id, after });
  assert.deepEqual((await query(one)).replies, [{ id: 101, text: 'first' }]);
  assert.deepEqual((await query(two)).replies, [{ id: 102, text: 'second' }]);
  assert.deepEqual((await query(two, 102)).replies, []);
  await f.hub.runs.action({ op: 'finish', id: one });
  await f.message(a.topic, 'late', 103);
  assert.equal((await query(two)).replies.length, 1);
  await assert.rejects(query(one), /not registered/);
});

test('a topic survives a restart, renames in place, and recovers from deletion', async t => {
  const f = fixture(t), run = { id: one, label: 'Tests' };
  const [a,b] = await Promise.all([f.topics.ensure(run), f.topics.ensure(run)]);
  assert.equal(a,b);
  const next = new Topics(f.api, 42, '1', f.dir, f.box);
  assert.equal(await next.ensure({ id: one, label: 'fallback' }), a);
  assert.equal(next.entries.get(one).label, 'Tests');
  assert.equal(await next.ensure({ ...run, label: 'More tests', explicitLabel: true }), a);
  assert.equal(f.calls.filter(c => c.method === 'createForumTopic').length, 1);
  assert.equal(f.calls.filter(c => c.method === 'editForumTopic').length, 1);
  f.dead.add(a);
  const sent = await next.send({ ...run, label: 'More tests', explicitLabel: true }, 'hello');
  assert.notEqual(sent.message_thread_id, a);
  assert.equal(next.sessionId(a), undefined);
  assert.equal(next.sessionId(sent.message_thread_id), one);
});

test('native sessions stay silent until selected, accept topic steering, and reject cross-topic buttons', async t => {
  const f = fixture(t), commands = [];
  const s = new Session(f.hub, m => commands.push(m), () => {});
  for (const id of [one,two]) {
    s.server({ method: 'thread/started', params: { thread: { id, cwd: process.cwd() } } });
    s.server({ method: 'turn/started', params: { threadId: id, turn: { id: 'turn' } } });
  }
  assert.equal(f.sent.length, 0);
  for (const id of [one,two]) assert.equal((await f.hub.runs.action({ op: 'watch', id, label: 'Build' })).mode, 'native');
  const a = f.topics.entries.get(one).topic, b = f.topics.entries.get(two).topic;
  await f.message(b, 'run tests', 60);
  assert.equal(commands[0].params.threadId, two);
  s.server({ id: commands[0].id, result: {} });
  s.server({ id: 7, method: 'item/commandExecution/requestApproval', params: {
    threadId: one, turnId: 'turn', itemId: 'item', command: 'pwd', cwd: '/work',
  } });
  await flush();
  const approval = f.sent.find(m => m.reply_markup);
  assert.equal(approval.message_thread_id, a);
  const callback = topic => f.hub.update({ callback_query: { id: 'cb', from: { id: 42 },
    data: approval.reply_markup.inline_keyboard[0][0].callback_data,
    message: { chat: { id: 42, type: 'private' }, message_id: approval.message_id, message_thread_id: topic } } });
  await callback(b);
  assert.equal(commands.length, 1);
  await callback(a);
  assert.deepEqual(commands[1], { id: 7, result: { decision: 'accept' } });
  s.close();
});
