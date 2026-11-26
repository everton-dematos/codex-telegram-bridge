import { randomBytes, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { isUserConversation, projectPath } from './local.js';
import { replyTarget, resumeCommand, Runs, runTag } from './runs.js';
import { privateSender } from './telegram.js';

const APPROVE = 'item/commandExecution/requestApproval';
const ASK = 'item/tool/requestUserInput';
const reviewMs = 15 * 60_000;
const cap = (text, limit = 3450) => text.length <= limit ? text : text.slice(0, limit) + '…';

// Make controls and direction changes visible in decision prompts.
const visible = text => String(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
  char => '\\u{' + char.codePointAt(0).toString(16) + '}');

function negativeDecision(p) {
  if (!p.availableDecisions || p.availableDecisions.includes('decline')) return 'decline';
  return p.availableDecisions.includes('cancel') ? 'cancel' : null;
}

function approvalText(p) {
  const { command, cwd, reason, threadId, turnId, itemId, startedAtMs, approvalId,
    availableDecisions, commandActions, proposedExecpolicyAmendment, proposedNetworkPolicyAmendments, ...context } = p;
  const fields = [
    ['Command', command], ['Working directory', cwd], ['Reason', reason],
    ...Object.entries(context),
  ];
  const text = fields.filter(([, value]) => value != null).map(([label, value]) =>
    label + '  ' + visible(typeof value === 'string' ? value : JSON.stringify(value))).join('\n');
  const decisions = p.availableDecisions;
  const supported = (!p.kind || p.kind === 'command' || p.kind === 'humanCommand')
    && (p.networkApprovalContext?.host || (typeof p.command === 'string' && p.command.length && p.cwd))
    && (!decisions || (Array.isArray(decisions) && decisions.includes('accept') && negativeDecision(p)));
  if (!supported || text.length > 3300) return null;
  return 'Command approval\n' + text;
}

function questionText(p) {
  if (!p.questions?.length || p.questions.some(q => q.isSecret)) return null;
  const text = p.questions.map((q, i) => {
    const options = (q.options || []).map(o => '  • ' + visible(o.label) + ' — ' + visible(o.description)).join('\n');
    return (i + 1) + '. ' + visible(q.question) + (options ? '\n' + options : '');
  }).join('\n');
  return text.length <= 3150 ? 'Codex needs your input\n' + text + '\nReply to this message with one answer per question, in order.' : null;
}

export class Bridge {
  constructor({ project, owner, send, acknowledge, topics, now = Date.now }) {
    Object.assign(this, { project, owner, send, acknowledge, topics, now });
    this.sessions = new Set();
    this.projects = new Map();
    this.runs = new Runs(this);
    this.routes = new Map();
    this.tickets = new Map();
  }
  post(text, route, options) {
    const sent = route?.thread && this.topics ? this.topics.send(route.thread, text, options) : this.send(text, options);
    const delivery = sent.then(m => {
      if (route && route.session.open && (!route.ticket || this.tickets.has(route.ticket))) {
        this.routes.set(m.message_id, route);
        if (this.routes.size > 4000) this.routes.delete(this.routes.keys().next().value);
      }
    });
    delivery.catch(e => console.error('Notification failed:', e.message)); // The outbox reports delivery errors to the workstation.
    return delivery;
  }
  note(session, thread, text, extras = {}, options) {
    return this.post(runTag(thread) + ' ' + text,
      { session, thread, turn: thread.turn, active: thread.active, ...extras }, options);
  }
  register(session, thread, request) {
    const p = request.params;
    const prompt = request.method === APPROVE ? approvalText(p) : request.method === ASK ? questionText(p) : null;
    if (!prompt) {
      this.note(session, thread, 'Codex needs a decision in your local client (' + request.method + ').', { localOnly: true });
      return;
    }
    const key = randomBytes(16).toString('hex');
    this.tickets.set(key, { session, thread, turn: p.turnId, request, until: this.now() + reviewMs });
    const options = request.method === APPROVE ? { reply_markup: { inline_keyboard: [[
      { text: 'Approve once', callback_data: 'allow.' + key }, { text: negativeDecision(p) === 'cancel' ? 'Cancel turn' : 'Deny', callback_data: 'deny.' + key },
    ]] } } : {};
    this.note(session, thread, prompt, { ticket: key }, options).catch(() => this.tickets.delete(key));
  }
  clearTickets(predicate) {
    for (const [key, t] of this.tickets) if (predicate(t)) this.tickets.delete(key);
  }
  tick() {
    this.runs.expire();
    this.clearTickets(t => t.until <= this.now());
    for (const s of this.sessions) for (const t of s.threads.values()) {
      if (t.watched && t.active && this.now() - t.lastNotice >= 600000) {
        t.lastNotice = this.now();
        this.note(s, t, 'Still running. ' + t.activity);
      }
    }
  }
  async button(callback, route) {
    const [action, key] = String(callback.data).split('.');
    const ticket = this.tickets.get(key);
    let text = 'This approval is no longer pending.';
    if (ticket && ticket.thread.watched && route?.ticket === key && ticket.request.method === APPROVE
        && ticket.thread.active && ticket.turn === ticket.thread.turn && ticket.until > this.now()
        && ['allow', 'deny'].includes(action)) {
      const decision = action === 'allow' ? 'accept' : negativeDecision(ticket.request.params);
      if (ticket.session.respond(ticket.request.id, { decision })) {
        text = { accept: 'Approved once.', decline: 'Denied.', cancel: 'Cancellation sent.' }[decision];
        this.note(ticket.session, ticket.thread, text);
      }
    }
    // A failed button acknowledgement must not repeat a Codex decision.
    await this.acknowledge(callback.id, text).catch(e => console.error('Telegram button acknowledgement failed:', e.message));
  }
  status(only, originTopic) {
    let count = 0;
    this.clearTickets(ticket => ticket.until <= this.now());
    for (const session of this.sessions) {
      for (const thread of session.threads.values()) {
        if (!thread.watched || (only && thread.id !== only)) continue;
        this.note(session, thread, (thread.active ? 'Running. ' : 'Idle. ') + thread.activity + '\nReply here to send an instruction.');
        count++;
      }
      // Reissue expired buttons only for requests the connected Codex still has open.
      const liveIds = new Set([...this.tickets.values()].filter(t => t.session === session).map(t => t.request.id));
      for (const { request } of session.requests.values()) {
        if (!request || liveIds.has(request.id)) continue;
        const thread = session.threads.get(request.params.threadId);
        if ((!only || thread?.id === only) && thread?.watched && thread.active && thread.turn === request.params.turnId) this.register(session, thread, request);
      }
    }
    for (const run of this.runs.mail.values()) {
      if (only && only !== run.id) continue;
      this.runs.send(run, 'Watching this run. Reply here to send an instruction.').catch(() => {});
      count++;
    }
    if (!count) this.post('No attached Codex run here.', undefined, originTopic ? { message_thread_id: originTopic } : {});
  }
  async update(u) {
    const cb = u.callback_query;
    const m = cb ? cb.message : u.message;
    const from = cb ? cb.from : m?.from;
    if (!privateSender(m, from) || from.id !== this.owner) return;
    const target = cb ? m.message_id : replyTarget(m);
    let route = this.routes.get(target);
    let topicRun = this.topics?.sessionId(m.message_thread_id);
    // In the main private chat Telegram can deliver a quoted topic message
    // without an outer thread ID. An exact bot message ID still identifies it.
    if (!cb && target && (!m.message_thread_id || m.message_thread_id === 1)) {
      topicRun = this.topics?.sessionId(m.reply_to_message.message_thread_id)
        ?? route?.thread.id ?? this.runs.messages.get(target)?.id;
    }
    if (route && this.topics && route.thread.id !== topicRun) return;
    if (cb) return this.button(cb, route);
    const feedback = text => this.post(text, undefined, m.message_thread_id ? { message_thread_id: m.message_thread_id } : {});

    if (!m.text) return;
    const msg = m.text.trim();
    if (msg === '/status' || msg === '/start' || msg === '/help') {
      if (m.message_thread_id > 1 && !topicRun) feedback('No Codex run is registered to this topic.');
      else this.status(topicRun, m.message_thread_id);
      return;
    }
    if (this.runs.receive(m, topicRun)) return;
    // An explicit reply is bound to its original turn or request, even after it expires.
    // A topic message without a reply addresses the currently attached turn.
    if (!route && topicRun && !replyTarget(m)) {
      for (const session of this.sessions) {
        const thread = session.threads.get(topicRun);
        if (thread?.watched && (!m.date || m.date >= Math.floor(thread.since / 1000))) {
          const questions = [...this.tickets.entries()].filter(([, item]) => item.session === session && item.thread === thread && item.request.method === ASK && item.until > this.now());
          if (questions.length > 1) { feedback('Reply to the specific question you want to answer.'); return; }
          route = { session, thread, turn: thread.turn, active: thread.active, ticket: questions[0]?.[0] };
          break;
        }
      }
    }
    if (!route || !route.thread.watched || !route.session.open || route.session.threads.get(route.thread.id) !== route.thread) {
      if (topicRun && !this.runs.mail.has(topicRun) && ![...this.sessions].some(s => s.threads.get(topicRun)?.watched)) {
        const command = resumeCommand(topicRun);
        const hint = command ? ' To continue on the workstation, run:\n' + command : '';
        feedback('This session is disconnected.' + hint);
      } else {
        feedback('Open the topic for an active Codex session and send your message there. Send /status to list attached sessions.');
      }
      return;
    }
    if (route.localOnly) { feedback('Complete this request in your local Codex client.'); return; }
    const { session, thread, ticket, turn } = route;
    if (ticket) {
      const t = this.tickets.get(ticket);
      if (!t || t.turn !== thread.turn || !thread.active || t.until <= this.now()) { feedback('This request expired or was already answered.'); return; }
      if (t.request.method !== ASK) { feedback('Use the buttons on the approval request.'); return; }
      const questions = t.request.params.questions;
      const lines = questions.length === 1 ? [msg] : msg.split('\n').map(x => x.trim());
      if (lines.length !== questions.length || questions.some((q, i) =>
        !lines[i] || (q.options?.length && !q.isOther && !q.options.some(o => o.label === lines[i])))) {
        feedback('Reply to the original question with each answer on its own line. Use the option labels shown for fixed choices.');
        return;
      }
      if (session.respond(t.request.id, { answers: Object.fromEntries(questions.map((q, i) => [q.id, { answers: [lines[i]] }])) })) {
        this.note(session, thread, 'Answer sent.');
      }
      return;
    }
    const replyToFinal = !thread.active && route.answerId && route.answerId === thread.completedAnswerId;
    if (thread.turn !== turn || (route.active !== thread.active && !replyToFinal)) { feedback('The turn has changed. Reply to a fresh /status message.'); return; }
    if (msg === '/stop' && !thread.active) { feedback('This thread is idle.'); return; }
    if (!msg || thread.sending) { feedback('Wait for the previous instruction to reach Codex.'); return; }
    const input = [{ type: 'text', text: msg }];
    const method = msg === '/stop' ? 'turn/interrupt' : thread.active ? 'turn/steer' : 'turn/start';
    const params = method === 'turn/interrupt' ? { turnId: turn } :
      method === 'turn/steer' ? { expectedTurnId: turn, input } : { input };
    thread.sending = true;
    session.call(method, { threadId: thread.id, ...params }).then(() => {
      this.note(session, thread, method === 'turn/interrupt' ? 'Interrupt requested.' : 'Codex received your instruction.');
    }, e => { feedback('Codex could not apply that instruction. ' + cap(e.message, 400)); })
      .finally(() => { thread.sending = false; });
  }
}

export class Session {
  constructor(hub, upstream, downstream, { autoWatch = false } = {}) {
    Object.assign(this, { hub, upstream, downstream, autoWatch });
    this.open = true;
    this.threads = new Map();
    this.requests = new Map();
    this.clientMethods = new Map();
    this.internal = new Map();
    this.rpcPrefix = 'telegram-' + randomUUID() + '-';
    this.rpcSequence = 0;
    hub.sessions.add(this);
  }
  observeThread(data, openedByClient = false) {
    if (!isUserConversation(data)) return;
    const cwd = projectPath(data.cwd);
    if (!cwd) { this.forget(data.id); return; }
    let t = this.threads.get(data.id);
    if (!t) {
      const label = this.hub.topics?.entries.get(data.id)?.label || basename(cwd);
      t = { id: data.id, cwd, since: this.hub.now(), label, watched: cwd === this.hub.project || this.hub.projects.has(cwd), active: false, turn: null, activity: 'Waiting for a turn.', lastNotice: 0 };
      this.threads.set(data.id, t);
    }
    const last = data.turns?.at(-1);
    if (last && !t.turn) { t.turn = last.id; t.active = last.status === 'inProgress'; }
    if (this.autoWatch && openedByClient && !t.launchAttached) {
      // An interrupted ordinary client may have left a polling inbox for this ID.
      // New topic messages now belong to the interactive client.
      const mailbox = this.hub.runs.mail.get(t.id);
      if (mailbox) this.hub.runs.close(mailbox);
      t.launchAttached = true;
      t.optIn = true;
      t.watched = true;
      const earlier = mailbox?.replies.length ? ' If an earlier instruction still needs an answer, send it again here.' : '';
      this.hub.note(this, t, 'Connected to your Codex CLI. Send a message in this topic to continue the conversation.' + earlier);
    }
  }
  forget(id) {
    this.threads.delete(id);
    this.hub.clearTickets(t => t.session === this && t.thread.id === id);
  }
  clear(id) {
    this.requests.delete(id);
    this.hub.clearTickets(t => t.session === this && t.request.id === id);
  }
  respond(id, result) {
    if (!this.open || !this.requests.has(id)) return false;
    this.clear(id);
    this.upstream({ id, result });
    return true;
  }
  client(m, raw) {
    if (m.id != null && !m.method) {
      if (!this.requests.has(m.id)) return; // The phone or Codex already resolved it.
      this.clear(m.id);
    }
    if (m.id != null && m.method) this.clientMethods.set(m.id, { method: m.method, threadId: m.params?.threadId });
    this.upstream(m, raw);
  }
  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.rpcPrefix + ++this.rpcSequence;
      const timer = setTimeout(() => {
        this.internal.delete(id);
        reject(new Error('No acknowledgement yet. Check /status before retrying.'));
      }, 20000);
      this.internal.set(id, m => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
      this.upstream({ id, method, params });
    });
  }
  server(m, raw) {
    if (m.id != null && !m.method) {
      const reply = this.internal.get(m.id);
      if (reply) { this.internal.delete(m.id); reply(m); return; }
      if (typeof m.id === 'string' && m.id.startsWith(this.rpcPrefix)) return;
      const pending = this.clientMethods.get(m.id);
      const method = pending?.method;
      if (method === 'thread/unsubscribe' && !m.error) this.forget(pending.threadId);
      this.clientMethods.delete(m.id);
      if (['thread/start', 'thread/resume', 'thread/fork'].includes(method)) this.observeThread(m.result?.thread, true);
    }
    const p = m.params || {};
    if (m.method === 'thread/started') this.observeThread(p.thread);
    if (m.method === 'serverRequest/resolved') this.clear(p.requestId);
    if (m.method === 'thread/closed' || m.method === 'thread/archived') this.forget(p.threadId);
    const t = this.threads.get(p.threadId);
    if (m.method && m.id != null) {
      this.requests.set(m.id, { thread: p.threadId, turn: p.turnId, request: t && [APPROVE, ASK].includes(m.method) ? m : null });
      if (t?.watched && p.turnId && t.active && t.turn === p.turnId) this.hub.register(this, t, m);
    } else if (t && m.method) {
      this.event(t, m.method, p);
    }
    this.downstream(m, raw);
  }
  event(t, method, p) {
    const note = (text, extras) => {
      if (!t.watched) return;
      t.lastNotice = this.hub.now();
      this.hub.note(this, t, text, extras);
    };
    if (method === 'turn/started') {
      this.hub.clearTickets(ticket => ticket.session === this && ticket.thread === t && ticket.turn !== p.turn.id);
      t.since = this.hub.now();
      t.turn = p.turn.id;
      t.lastAnswerId = null;
      t.completedAnswerId = null;
      t.active = true;
      t.activity = 'Turn started.';
      note('Codex started. Reply to steer this turn.');
    } else if (method === 'turn/completed' && t.turn === p.turn.id) {
      t.active = false;
      t.completedAnswerId = p.turn.status === 'completed' ? t.lastAnswerId : null;
      for (const [id, r] of this.requests) if (r.thread === t.id && r.turn === t.turn) this.clear(id);
      t.activity = 'Turn ' + p.turn.status + '.';
      note(t.activity + (p.turn.error?.message ? '\n' + cap(p.turn.error.message) : ''));

    } else if (p.turnId && p.turnId !== t.turn) {
      return;
    } else if (method === 'error') {
      note((p.willRetry ? 'Codex is retrying. ' : 'Codex error. ') + cap(p.error?.message || 'See local client.'));
    } else if (method === 'item/started') {
      t.activity = 'Latest activity: ' + p.item.type + '.';
    } else if (method === 'item/completed') {
      const i = p.item;
      if (i.type === 'agentMessage' && i.text?.trim()) {
        const terminal = i.phase === 'final_answer' || i.phase == null;
        t.lastAnswerId = terminal ? i.id : null;
        note(cap(i.text), { answerId: t.lastAnswerId });
      } else if (i.type === 'commandExecution' && (i.status === 'failed' || (i.exitCode != null && i.exitCode !== 0))) {
        note('Command failed' + (i.exitCode != null ? ' (exit ' + i.exitCode + ')' : '') + '.\n' + cap(i.command || '', 650));
      } else if (i.status === 'failed') note('Codex reported a failed ' + i.type + '. See the local client for details.');
    }
  }
  close() {
    if (!this.open) return;
    this.open = false;
    for (const t of this.threads.values()) if (t.watched && t.active) this.hub.note(this, t, 'Connection lost during a turn. Check the workstation.');
    for (const callback of this.internal.values()) callback({ error: { message: 'Codex disconnected.' } });
    this.hub.clearTickets(t => t.session === this);
    for (const [id, r] of this.hub.routes) if (r.session === this) this.hub.routes.delete(id);
    this.internal.clear();
    this.hub.sessions.delete(this);
  }
}
