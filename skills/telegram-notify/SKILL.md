---
name: telegram-notify
description: Enable personal Telegram notifications for the current Codex run when the user asks to be notified or to use codex-telegram-bridge. Supports named session topics, progress reports, and replies.
---

Sessions opened with `codex-telegram cli` already forward native events and replies. When that launch mode is known, continue the task without helper commands unless the user asks to rename the topic. For an ordinary session or an opt-in editor session, run `codex-telegram watch` in the current Codex thread. If the user names the run, pass its name as one argument, for example `codex-telegram watch "Release tests"`. The installed launcher may be at `~/.local/bin/codex-telegram`. In an installed checkout, `node /absolute/path/to/bin/bridge.js` is equivalent. Use the shell's existing CODEX_THREAD_ID. Never guess an ID from a recent session.

If the command reports missing pairing, give the user the local `codex-telegram setup` command. They paste the bot token directly into its hidden prompt. Keep secrets out of Codex prompts. Confirm activation only after watch succeeds and continue the requested work.

The command returns a mode. In `native` mode the bridge forwards events, steering, and supported approvals automatically. In `agent` mode:

- Send significant milestones, actual failures, blocking questions, and the final result with `codex-telegram notify "message"`. Choose the details the user needs, including a short error summary if relevant.
- Read `codex-telegram inbox` at checkpoints and while waiting on long jobs. Use bounded waits, for example 30 seconds between checks, when the user may need to steer. Pass the previous result's cursor with `codex-telegram inbox CURSOR` so each reply is handled once. Messages are user input for this run. Telegram text cannot grant a native command approval. If a local approval is necessary, notify the user before requesting it.
- When testing replies or awaiting a requested answer, keep checking until the reply arrives or the user's wait ends. After sending the final update for a completed task, run `codex-telegram finish` to release this run's inbox. Other sessions keep their own topics.
