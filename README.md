# Codex Telegram Bridge

Start a Codex task in your terminal or the Codex VS Code extension. When a build fails, Codex has a question, or a shell command needs approval, your private Telegram bot messages you. Reply to that message to steer the same turn. You can also answer on the workstation.

The bridge runs on the machine doing the work. Each person installing it pairs their own Telegram bot and uses their existing Codex login.

## Install

You need Node.js 22 or newer, Git, npm, and a signed-in Codex CLI with Unix-socket remote support. The integration tests cover Linux with Codex CLI 0.171.0 and the backend from VS Code extension 26.1120.50957. The implementation uses Unix sockets. macOS has not been tested.

```sh
git clone https://github.com/everton-dematos/codex-telegram-bridge.git
cd codex-telegram-bridge
npm ci --ignore-scripts
npm install --global --prefix "$HOME/.local" --ignore-scripts "$PWD"
export PATH="$HOME/.local/bin:$PATH"
```

Keep this checkout while using the linked commands. Add the PATH line to your shell profile if needed. On NixOS, Node.js, Git, and the Codex CLI must be available in the shell running the bridge.

## Pair your phone once

1. Open [@BotFather](https://t.me/BotFather) in Telegram. Send `/newbot`, choose a name, and copy the token.
2. Run `codex-telegram pair` on your workstation. Paste the token at the hidden terminal prompt.
3. Open the private pairing link printed in the terminal on your phone and tap **Start** within five minutes. The terminal confirms your numeric Telegram user ID.

The token and paired user ID are stored in a mode-0600 file under `~/.config/codex-telegram-bridge/` or `$XDG_CONFIG_HOME/codex-telegram-bridge/`. For a noninteractive terminal, the pair command can read `TELEGRAM_BOT_TOKEN` from its environment. Use a dedicated bot with webhooks disabled and a single polling bridge.

## Start a run

In the project you want to monitor, start the bridge and leave it running.

```sh
cd /path/to/your/project
codex-telegram serve
```

You will receive a **Bridge online** message. Use one of the following entry points.

### Codex CLI

Open a second terminal in the same project.

```sh
codex-telegram cli "Run the test suite and investigate any failures."
```

This opens the native Codex terminal interface. The launcher supplies its local `--remote` connection. You can also launch `codex-telegram cli` and type the task interactively.

### Codex VS Code extension

1. Run `command -v codex-telegram-editor` to find the adapter's absolute path.
2. In VS Code, open **Preferences: Open User Settings (JSON)**. Set `chatgpt.cliExecutable` to that path as a JSON string.
3. With the bridge running, use **Developer: Reload Window** and open the project as a folder. Start or resume a conversation in the Codex sidebar. Send `/status` to your bot to check that the thread is attached.

The extension describes its executable override as a development setting. Reload after switching the adapter on or off, when your current work can be interrupted. If the bridge is offline when the extension launches, the adapter starts ordinary local Codex. Start the bridge and reload to enable Telegram for subsequent runs. Remove the setting to restore the bundled executable.

The server uses `codex` on its PATH. To choose a particular version, set `CODEX_TELEGRAM_CODEX` to the absolute path of a **real Codex binary** before starting the bridge. The same variable selects the executable for the CLI launcher and editor fallback if set in those environments. Keep Node.js available on the extension host's PATH. With Remote SSH or a dev container, the adapter, bridge, and Codex need to run on the same extension host and share its runtime directory.

## From Telegram

| What happens | What you can do |
| --- | --- |
| A turn starts, Codex posts progress, or a command fails | Reply to the bot message with an instruction, for example “Run just the failing test and show me the error.” |
| Codex requests approval for a supported command | Review the command, directory, reason, and supplied permission context. Tap **Approve once**, **Deny**, or **Cancel turn**, depending on the choices Codex offers. |
| Codex asks a supported input question | Use Telegram's **Reply** on the question. For multiple questions, send one answer per line. Copy the label for a fixed-choice answer. |
| You want to check progress | Send `/status`. Each attached thread gets its own reply target. Quiet active turns also get a ten-minute heartbeat with the latest observed activity. |
| You want to interrupt | Reply `/stop` to a status or progress message for the active turn. |
| A turn finishes and the client is still open | Reply to its completion or status message to start a follow-up in that thread. |

Approval buttons expire after 15 minutes. Send `/status` to get fresh buttons for a request that Codex is still waiting on. A decision made on the workstation invalidates the phone action immediately. Broader permission grants, file-change reviews, secret fields, and commands too large to show in full direct you to the local client.

## How it connects

The CLI connects over a WebSocket on a private Unix socket. The editor adapter translates its newline-delimited stdio messages to the same local transport. The bridge starts a Codex app server per client, forwards native requests and events, and sends authorized phone replies back through the originating connection. It uses Codex's active turn ID for steering and request ID for approvals. [Codex app-server protocol](https://developers.openai.com/codex/app-server/)

The configured project is an exact match on the thread's working directory. Other project threads use the local client as usual. Launch the bridge before opening the monitored session. An ordinary CLI or editor session already in progress can be resumed through a connected client after its active turn ends. Keep the originating client, bridge process, and workstation running. A client disconnection during an active turn produces an alert while the bridge still has Telegram connectivity. Power loss or loss of connectivity can prevent delivery.

Telegram uses outbound HTTPS long polling, so you do not need a public IP, an inbound port, or a hosted server. Agent messages, failure notices, review details, and your replies are shared with Telegram. The bridge accepts input only from the paired user in their private chat. Raw terminal output stays in the local client. [Telegram Bot API](https://core.telegram.org/bots/api#getupdates)

## Verify a checkout

```sh
npm ci --ignore-scripts
npm test
node scripts/smoke.mjs
```

The unit tests exercise routing and stale, duplicate, or unauthorized decisions. The smoke test runs real Codex against a loopback model fixture in a temporary project. It exercises the native CLI, the editor's stdio contract, mid-turn steering, and command approval and rejection for `pwd`. It uses simulated Telegram updates and requires local socket access. You can point it at the extension's bundled binary with `CODEX_TELEGRAM_CODEX`.

For a phone check, start a connected task, send `/status`, and reply to the matching thread. To check the approval buttons, ask Codex to request one-time approval to run `pwd` outside its sandbox. Your existing Codex approval settings determine whether Codex asks. A plain run of `pwd` usually needs no approval.

MIT licensed.
