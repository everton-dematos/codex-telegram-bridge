import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bridge, Session } from '../lib/bridge.js';

function setup() {
  const sent = [], upstream = [], downstream = [], acks = [];
  let now = 1000000;
  const hub = new Bridge({ project: process.cwd(), owner: 123, now: () => now,
    send: async (text, options) => { sent.push({ text, ...options }); return { message_id: sent.length }; },
    acknowledge: async (id, text) => { acks.push(text); },
  });
  const s = new Session(hub, m => upstream.push(m), m => downstream.push(m));
  const p = { threadId: 'thread-abc', turnId: 'turn1', itemId: 'item1' };
  const emit = (method, params, id) => s.server({ method, params: { ...p, ...params }, ...(id == null ? {} : { id }) });
  emit('thread/started', { thread: { id: p.threadId, cwd: process.cwd() } });
  emit('turn/started', { turn: { id: p.turnId } });
  const answer = (n, text) => hub.update({ message: { text, chat: { type: 'private', id: 123 }, from: { id: 123 }, reply_to_message: { message_id: n } } });
  const click = (n, sender = 123, type = 'private', action = 0) => hub.update({ callback_query: {
    message: { message_id: n, chat: { type, id: 123 } }, from: { id: sender },
    data: sent[1].reply_markup.inline_keyboard[0][action].callback_data, id: 'cb',
  } });
  return { hub, s, p, emit, sent, upstream, downstream, acks, answer, click, advance: n => { now += n; } };
}

test('an owner can approve exactly the displayed request once across both clients', async () => {
  const x = setup();
  x.emit('item/commandExecution/requestApproval', { command: 'pwd', cwd: '/tmp' }, 7);
  await Promise.resolve();
  assert.match(x.sent[1].text, /pwd/);
  await x.click(2, 99);
  await x.click(2, 123, 'group');
  await x.click(1);
  assert.deepEqual(x.upstream, []);
  await x.click(2);
  await x.click(2);
  x.s.client({ id: 7, result: { decision: 'decline' } });
  assert.deepEqual(x.upstream, [{ id: 7, result: { decision: 'accept' } }]);
  assert.match(x.acks.at(-1), /no longer pending/);
});

test('local answer, server cancellation, expiration and disconnection invalidate remote actions', async () => {
  for (const finish of ['local', 'resolved', 'turn', 'time', 'closed']) {
    const x = setup();
    x.emit('item/commandExecution/requestApproval', { command: 'pwd', cwd: '/tmp' }, 7);
    await Promise.resolve();
    if (finish === 'local') x.s.client({ id: 7, result: { decision: 'decline' } });
    if (finish === 'resolved') x.emit('serverRequest/resolved', { requestId: 7 });
    if (finish === 'turn') x.emit('turn/completed', { turn: { id: 'turn1', status: 'completed' } });
    if (finish === 'time') x.advance(16 * 60000);
    if (finish === 'closed') x.s.close();
    await x.click(2);
    assert.equal(x.upstream.some(m => m.result?.decision === 'accept'), false);
  }
});

test('missing command, oversized requests, unsupported decisions and secret prompts stay local', async () => {
  const x = setup();
  for (const params of [{}, { command: 'x'.repeat(3999), cwd: '/p' }, { command: 'pwd', cwd: '/p', availableDecisions: ['cancel'] }]) {
    x.emit('item/commandExecution/requestApproval', params, 2);
    assert.equal(x.sent.at(-1).reply_markup, undefined);
  }
  x.emit('item/tool/requestUserInput', { questions: [{ id: 'secret', question: 'sensitive', isSecret: true }] }, 3);
  assert.doesNotMatch(x.sent.at(-1).text, /sensitive/);
  assert.equal(x.hub.tickets.size, 0);
});

test('question replies map to the exact request and validate all fixed choices', async () => {
  const x = setup();
  x.emit('item/tool/requestUserInput', { questions: [{ id: 'a', question: 'Choose', options: [{ label: 'A', description: 'Fast' }] },
    { id: 'b', question: 'What name?' }] }, 8);
  await Promise.resolve();
  await x.answer(2, 'B\nCat');
  assert.equal(x.upstream.length, 0);
  await x.answer(2, 'A\nCat');
  assert.deepEqual(x.upstream[0], { id: 8, result: { answers: { a: { answers: ['A'] }, b: { answers: ['Cat'] } } } });
});

test('reply steers the expected active turn, follows up after completion, rejects old turns', async () => {
  const x = setup();
  await Promise.resolve();
  await x.answer(1, 'Run the short test');
  const steer = x.upstream[0];
  assert.equal(steer.method, 'turn/steer');
  assert.equal(steer.params.expectedTurnId, 'turn1');
  x.s.server({ id: steer.id, result: {} });
  await new Promise(r => setImmediate(r));
  x.emit('turn/completed', { turn: { id: 'turn1', status: 'completed' } });
  await Promise.resolve();
  await x.answer(x.sent.length, 'Now run the full suite');
  assert.equal(x.upstream[1].method, 'turn/start');
  x.s.server({ id: x.upstream[1].id, result: {} });
  x.emit('turn/started', { turn: { id: 'turn2' } });
  await x.answer(1, 'Late reply');
  assert.equal(x.upstream.length, 2);
  assert.equal(x.downstream.some(m => m.id === steer.id), false);
});

test('project scope, command failures, retries and hung-turn notifications', () => {
  const x = setup();
  x.emit('thread/started', { thread: { id: 'another', cwd: '/' } });
  x.emit('item/completed', { threadId: 'another', item: { type: 'agentMessage', text: 'private data' } });
  assert.equal(x.sent.length, 1);
  x.emit('item/completed', { item: { type: 'commandExecution', command: 'build', exitCode: 1 } });
  x.emit('error', { willRetry: true, error: { message: 'offline' } });
  x.advance(600001);
  x.hub.tick();
  assert.match(x.sent[1].text, /failed.*exit 1/);
  assert.match(x.sent[2].text, /retrying/);
  assert.match(x.sent[3].text, /Still running/);
});

test('calls outside the watched project pass through in both directions without phone access', () => {
  const x = setup();
  x.emit('item/commandExecution/requestApproval', { threadId: 'another' }, 21);
  x.s.client({ id: 21, result: { decision: 'decline' } });
  assert.deepEqual(x.upstream, [{ id: 21, result: { decision: 'decline' } }]);
  assert.equal(x.hub.tickets.size, 0);
});

test('expired approvals can be renewed from status while the original request is live', async () => {
  const x = setup();
  x.emit('item/commandExecution/requestApproval', { command: 'pwd', cwd: '/', availableDecisions: ['accept', 'cancel'] }, 0);
  await Promise.resolve();
  x.advance(16 * 60000);
  x.hub.status();
  await Promise.resolve();
  const renewed = x.sent.at(-1).reply_markup.inline_keyboard[0][1];
  assert.equal(renewed.text, 'Cancel turn');
  await x.click(2);
  assert.equal(x.upstream.length, 0);
  await x.hub.update({ callback_query: { from: { id: 123 }, data: renewed.callback_data,
    message: { chat: { type: 'private', id: 123 }, message_id: x.sent.length }, id: 'c' } });
  assert.deepEqual(x.upstream, [{ id: 0, result: { decision: 'cancel' } }]);
});

test('a late steer on a finished turn does not silently start another turn', async () => {
  const x = setup();
  x.emit('turn/completed', { turn: { id: 'turn1', status: 'completed' } });
  await Promise.resolve();
  await x.answer(1, 'Do this while still running');
  assert.deepEqual(x.upstream, []);
  assert.match(x.sent.at(-1).text, /turn has changed/);
});
