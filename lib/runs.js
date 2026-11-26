import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const day = 24 * 60 * 60 * 1000;
const idPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export function resumeCommand(id) {
  return idPattern.test(id) ? '~/.local/bin/codex-telegram cli resume ' + id : undefined;
}

export function runTag(run) {
  const short = createHash('sha256').update(run.id).digest('hex').slice(0, 10);
  const label = run.label.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 80);
  return '[' + label + ' · ' + short + ']';
}

export function replyTarget(message) {
  const reply = message.reply_to_message;
  if (reply?.forum_topic_created && reply.message_id === message.message_thread_id) return undefined;
  return reply?.message_id;
}

export class Runs {
  constructor(hub) {
    this.hub = hub;
    this.mail = new Map();
    this.messages = new Map();
  }
  close(run) {
    this.mail.delete(run.id);
    for (const [id, owner] of this.messages) if (owner === run) this.messages.delete(id);
  }
  expire() {
    for (const run of this.mail.values()) if (this.hub.now() - run.touched > day) this.close(run);
  }
  async send(run, text) {
    const tagged = runTag(run) + ' ' + text;
    const result = this.hub.topics ? await this.hub.topics.send(run, tagged) : await this.hub.send(tagged);
    if (this.mail.get(run.id) !== run) return;
    this.messages.set(result.message_id, run);
    if (this.messages.size > 4000) this.messages.delete(this.messages.keys().next().value);
  }
  receive(message, topicRun) {
    const target = replyTarget(message);
    const run = target ? this.messages.get(target) : this.mail.get(topicRun);
    if (!run || (this.hub.topics && run.id !== topicRun) || (message.date && message.date < Math.floor(run.started / 1000))) return false;
    if (run.replies.some(reply => reply.id === message.message_id)) return true;
    run.replies.push({ id: message.message_id, text: message.text });
    if (run.replies.length > 100) run.replies.shift();
    run.touched = this.hub.now();
    this.send(run, 'Reply queued. Codex can read it at its next check.').catch(e => console.error(e.message));
    return true;
  }
  async action({ op, id, cwd, label, text, after = 0 }) {
    if (!idPattern.test(id)) throw new Error('This command needs the current Codex thread ID (CODEX_THREAD_ID).');
    if (op === 'notify' && (typeof text !== 'string' || !text.trim() || text.length > 3400)) throw new Error('Supply a notification of 1 to 3400 characters.');
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 80 || /[\p{C}\p{Zl}\p{Zp}]/u.test(label))) throw new Error('Use a single-line label of 1 to 80 characters.');
    this.expire();
    for (const session of this.hub.sessions) {
      const thread = session.threads.get(id);
      if (!thread) continue;
      if (op === 'watch') {
        if (label) { thread.label = label; thread.explicitLabel = true; }
        const oldMailbox = this.mail.get(id);
        if (oldMailbox) this.close(oldMailbox);
        thread.optIn = true;
        if (!thread.watched) {
          thread.watched = true;
          for (const { request } of session.requests.values()) {
            if (request?.params.threadId === id && request.params.turnId === thread.turn) this.hub.register(session, thread, request);
          }
        }
        await this.hub.note(session, thread, 'Telegram is following this run. Reply here to steer.');
      } else if (op === 'notify') {
        if (!thread.watched) throw new Error('Run watch first.');
        await this.hub.note(session, thread, text);
      }
      if (op === 'finish') {
        thread.optIn = Boolean(thread.launchAttached);
        thread.watched = thread.optIn || thread.cwd === this.hub.project || this.hub.projects.has(thread.cwd);
      }
      return { mode: 'native', replies: [] };
    }
    let run = this.mail.get(id);
    if (op === 'watch') {
      if (!run) {
        run = { id, started: this.hub.now(), label: basename(cwd || 'Codex').slice(0, 120) || 'Codex', touched: this.hub.now(), replies: [] };
        this.mail.set(id, run);
      }
      if (label) { run.label = label; run.explicitLabel = true; }
      run.touched = this.hub.now();
      await this.send(run, 'Telegram notifications enabled. Reply here to send a message to Codex at its next check.');
      return { mode: 'agent' };
    }
    if (!run) throw new Error('This run is not registered. Run watch first.');
    run.touched = this.hub.now();
    if (op === 'inbox') {
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid message cursor.');
      const replies = run.replies.filter(reply => reply.id > after);
      return { mode: 'agent', replies, cursor: replies.at(-1)?.id ?? after };
    }
    if (op === 'notify') await this.send(run, text);
    else if (op === 'finish') this.close(run);
    else throw new Error('Unknown run command.');
    return { mode: 'agent' };
  }
}
