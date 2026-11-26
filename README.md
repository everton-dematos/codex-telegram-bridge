# Codex Telegram Bridge

One personal Telegram bot, one topic per Codex session. Ask in a task prompt:

> Use https://github.com/everton-dematos/codex-telegram-bridge to notify me during this run. Call the topic “Release tests”.

Open **Release tests** on your phone to see that session's updates and send it instructions. Another agent working on a build gets its own topic. The bot adds a short identifier to each topic name so even two runs called “Build” are distinguishable. It remembers the Telegram topic for each Codex session across bridge restarts.

## Set up once on your workstation

This project uses a personal bot for each user. You need Node.js 22 or newer, Git, npm, a Telegram account, and local Codex. The native integration was tested on Linux with Codex CLI 0.171.0 and the backend from VS Code extension 26.1120.50957. The bridge uses Unix sockets. macOS is untested.

```sh
git clone https://github.com/everton-dematos/codex-telegram-bridge.git
cd codex-telegram-bridge
npm ci --ignore-scripts
npm install --global --prefix "$HOME/.local" --ignore-scripts "$PWD"
export PATH="$HOME/.local/bin:$PATH"
codex-telegram setup
```

1. Setup installs the personal `telegram-notify` Codex skill. It guides you to [@BotFather](https://t.me/BotFather). Send `/newbot`, choose a bot name and username, and copy the token.
2. Paste the token into the **hidden prompt in your own terminal**. Open the private pairing link that the command prints and tap **Start**. The bot learns your Telegram user ID from that interaction. You do not enter a personal username or phone number.
3. Open Codex and ask it to notify you. Existing paired installations can run `setup` again to add the skill. Each local user account pairs once. All of that user's local Codex sessions share one bot and one update listener.

Keep the checkout in place while using its linked commands. If needed, add the PATH line to your shell profile. For NixOS or remote development, make Node.js and Codex available on the host actually running the agent. Use one dedicated bot per independently running workstation.

## From a task prompt

> Run the release tests. Use $telegram-notify for this run and name it “Release tests”.

If Codex is reading this repository from a link, follow the [notification skill](skills/telegram-notify/SKILL.md). Its first command is `codex-telegram watch "Release tests"` in the current agent shell. The helper takes the session ID from Codex, starts the local listener when needed, and confirms delivery to the paired chat. Subsequent prompts can omit the repository URL. An existing chat that has not discovered the skill yet can use the repository link.

| How you started Codex | What the prompt enables |
| --- | --- |
| Ordinary CLI or VS Code session already running | The agent posts milestones, questions, observed failures, and its final result. Type in its Telegram topic. The agent reads queued replies at its next check. The local Codex client still handles built-in command approvals. |
| Bridge-connected CLI or VS Code | Automatic progress, failure, and completion events, a heartbeat during quiet active turns, live steering, supported questions, and one-time command approvals in that session's topic. |

In an ordinary run, notifications rely on the agent reaching its next checkpoint. Use a connected client for immediate native approval prompts and runtime events. A private app-server connection already owned by another client cannot be retrofitted into the relay mid-turn.

### Start with native approvals

**CLI** — Launch `codex-telegram cli` from your project, or include your prompt immediately:

```sh
codex-telegram cli 'Run the build. Use telegram-notify and name the topic Nightly build.'
```

**VS Code** — Run `command -v codex-telegram-editor`. Set `chatgpt.cliExecutable` to that absolute path in **Preferences: Open User Settings (JSON)**, then reload the window when your current work can be interrupted. Subsequent sidebar sessions can opt in by prompt. The extension describes this executable override as a development setting. If pairing is unavailable, the adapter starts ordinary local Codex. Remove the override to restore the bundled executable.

The listener starts on demand. To automatically monitor every **connected** session rooted at one project, run `codex-telegram serve --project /path/to/project` and leave that command running. It shares the same listener with prompt-enabled sessions. Stopping it releases project-wide monitoring. Explicitly opted-in sessions keep their topics.

The bridge uses `codex` on the listener's PATH. Set `CODEX_TELEGRAM_CODEX` to the absolute path of a real Codex executable to select another backend. In Remote SSH or a dev container, the adapter, agent, and bridge need to run on the same extension host and share its runtime directory.

## Using the bot

- **Send an instruction** by typing directly in the session topic. In connected mode, Codex steers the active turn or starts a follow-up if the thread is idle.
- **Check status** with `/status` inside the topic. From the main bot chat, `/status` asks all attached runs to report in their own topics.
- **Answer a question** by typing in the topic or replying to its prompt. If several native questions are pending, reply to the specific question. For multiple questions in one prompt, enter one answer per line.
- **Review a native command** using **Approve once**, **Deny**, or **Cancel turn**, depending on what Codex offers. A workstation decision invalidates the phone button immediately. Buttons expire after 15 minutes. Send `/status` to refresh an outstanding request. Broader grants, file-change reviews, secret inputs, and commands too large to show in full direct you to the workstation.
- **Interrupt a connected turn** with `/stop` in its topic. An ordinary run reads text instructions at its next checkpoint.

The bridge enables Telegram's private-chat topic sidebar on your dedicated bot and creates topics as sessions opt in. Only the paired account's private chat can send instructions. Credentials reside in a mode-0600 file in `~/.config/codex-telegram-bridge/` or under `$XDG_CONFIG_HOME`. Each bot and owner has a separate topic mapping. Topic names, agent updates, approval details, and replies are shared with Telegram. [Telegram topic settings](https://core.telegram.org/bots/api#setmysettings) · [Telegram topic creation](https://core.telegram.org/bots/api#createforumtopic)

Keep the workstation and originating client running. The listener uses outbound HTTPS long polling and local user-only sockets. It can report a connected client disconnect while Telegram is reachable. Host power loss or network loss can prevent delivery. Ordinary-run inboxes are in memory, keep the latest 100 replies, and expire after 24 hours of inactivity. A finished session's topic history stays in Telegram. [Codex app-server protocol](https://developers.openai.com/codex/app-server/)

## Verify a checkout

```sh
npm ci --ignore-scripts
npm test
node scripts/smoke.mjs
```

The tests cover two simultaneous agents with identical labels, topic reuse after restart, reply routing, and stale or cross-topic approvals. The smoke test uses real Codex, a loopback model fixture and simulated Telegram updates. It exercises the native CLI, the editor's stdio contract, steering, and approval and rejection of `pwd`. A live phone check requires your own bot and the pairing step.

MIT licensed.
