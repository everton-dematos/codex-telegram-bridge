import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { runTag } from './runs.js';

export class Topics {
  constructor(api, owner, botId, dir, outbox) {
    Object.assign(this, { api, owner, outbox });
    this.file = join(dir, 'topics-' + botId + '-' + owner + '.json');
    this.entries = new Map();
    this.pending = new Map();
    try { this.entries = new Map(JSON.parse(readFileSync(this.file, 'utf8'))); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  sessionId(topic) {
    if (!Number.isSafeInteger(topic)) return undefined;
    for (const [id, entry] of this.entries) if (entry.topic === topic) return id;
  }
  save() {
    const temp = this.file + '.' + randomUUID();
    writeFileSync(temp, JSON.stringify([...this.entries]), { mode: 0o600, flag: 'wx' });
    renameSync(temp, this.file);
  }
  async ensure(run) {
    if (!this.settings) {
      this.settings = this.api.call('setMySettings', { has_topics_enabled: true, has_topic_sidebar: true, callback_query_mode: 'default' })
        .catch(e => { this.settings = null; throw e; });
    }
    await this.settings;
    const prior = this.pending.get(run.id);
    if (prior) { await prior; return this.ensure(run); }
    const current = this.entries.get(run.id);
    if (current?.label && !run.explicitLabel) run.label = current.label;
    const name = runTag(run).slice(1, -1);
    if (current && current.name === name) return current.topic;
    const change = async () => {
      const chat_id = this.owner;
      let topic = current?.topic;
      if (topic) {
        try { await this.api.call('editForumTopic', { chat_id, message_thread_id: topic, name }); }
        catch (e) {
          if (missingTopic(e)) topic = undefined;
          else if (!/TOPIC_NOT_MODIFIED|not modified/i.test(e.message)) throw e;
        }
      }
      if (!topic) {
        const result = await this.api.call('createForumTopic', { chat_id, name });
        topic = result.message_thread_id;
        if (!Number.isSafeInteger(topic) || topic <= 0) throw new Error('Telegram returned an invalid topic.');
      }
      this.entries.set(run.id, { name, topic, label: run.label });
      this.save();
      return topic;
    };
    const job = change();
    this.pending.set(run.id, job);
    try { return await job; } finally { this.pending.delete(run.id); }
  }
  async send(run, text, options) {
    const topic = await this.ensure(run);
    const deliver = id => this.outbox.send(text, { ...options, message_thread_id: id });
    try { return await deliver(topic); }
    catch (e) {
      if (!missingTopic(e)) throw e;
      if (this.entries.get(run.id)?.topic === topic) { this.entries.delete(run.id); this.save(); }
      return deliver(await this.ensure(run));
    }
  }
}

function missingTopic(e) {
  return e.status === 400 && /thread not found|topic_deleted|topic_id_invalid/i.test(e.message);
}
