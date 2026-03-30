<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  Personal AI assistant (BiBi) — runs Claude agents securely in containers, reachable over WhatsApp, with a full web dashboard.
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>
</p>

This is a personal fork of [NanoClaw](https://github.com/qwibitai/NanoClaw). The assistant is named **BiBi** and runs on WhatsApp. Trigger BiBi in any chat with `@BiBi` (case-insensitive).

## Quick Start

```bash
git clone <your-fork>
cd NanoClaw
claude
```

Then run `/setup`. Claude Code handles everything: dependencies, WhatsApp authentication, container setup, and service configuration.

The dashboard auto-starts on login at **http://localhost:3838**.

---

## Dashboard

A local web dashboard is included at `groups/main/dashboard-server.js`, served on port **3838** and managed as a launchd service (`com.nanoclaw.dashboard`).

### Tabs

**Main** — Live stats (total messages, today's messages, active chats), recent message feed, and a built-in chat interface. Select any registered contact from a dropdown, pick a model, and chat directly from the browser. Includes a model selector bar with live Ollama model list.

**Share** — File manager for the `SHARE/` folder at the project root. Browse folders with breadcrumbs, upload files (click or drag-and-drop), download, rename, create folders, and delete. Used for exchanging files with BiBi.

**Terminal** — Full browser-based terminal powered by [xterm.js](https://xtermjs.org/) and [node-pty](https://github.com/microsoft/node-pty). Opens a real shell (zsh) at the NanoClaw root. Includes a command bar at the bottom (always visible), command history with ↑/↓ arrows, and a Reconnect button.

**Projects** — Browse the `~/dev/CLAUDE/` projects folder. Select a project from the dropdown and the Terminal tab automatically `cd`s into it. Includes a ⋯ three-dot menu with "Open in Terminal", "Copy path", and "Refresh". An "Active in Terminal" badge shows which project is currently selected.

### Dashboard Service

The dashboard runs as a launchd service and starts automatically on login:

```bash
# Start / stop
launchctl load ~/Library/LaunchAgents/com.nanoclaw.dashboard.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.dashboard.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.dashboard

# Logs
tail -f logs/dashboard.log
tail -f logs/dashboard.error.log
```

---

## Configuration Files

Two plain-text files at the project root let you change settings without touching code or restarting the service.

### `model.txt`

Controls which AI model BiBi uses. Read fresh on every container spawn — no restart needed.

```
# Line 1: primary model
# Line 2: fallback model
# Line 3+: additional options shown in dashboard dropdown
gemini-3-flash-preview:cloud
llama3.2
qwen3-coder-next:cloud
```

Supports any model available through Ollama (local or cloud-routed).

### `contacts.txt`

Registers WhatsApp contacts so BiBi responds to them. Loaded automatically on startup — add a line and restart the service.

```
# Format: phone_number | display_name | folder_name
11234567890 | main          | main
11234567891 | Alice Smith   | alice-smith
11234567892 | Bob Jones     | bob-jones
```

Each contact gets its own isolated container and `CLAUDE.md` memory under `groups/<folder>/`.

---

## Projects Access

BiBi's container mounts `~/dev/CLAUDE/` at `/workspace/extra/projects` (read-write). This means you can ask BiBi to read, edit, or work on any project in that folder directly from WhatsApp or the dashboard chat.

The mount allowlist lives at `~/.config/nanoclaw/mount-allowlist.json` (outside the project root so containers cannot tamper with it).

---

## Rebuilding

Run `./rebuild.sh` for a full clean rebuild — clears the Docker builder cache, rebuilds the container image, recompiles TypeScript, and restarts the service:

```bash
./rebuild.sh
```

Use this when changing container source files or after dependency updates.

---

## Usage

Trigger BiBi in any WhatsApp chat (any case):

```
@BiBi what's the weather today
@BiBi summarize the last 10 messages in this chat
@BiBi remind me at 9am every weekday to check emails
```

From your main channel (self-chat):

```
@BiBi list all scheduled tasks
@BiBi show registered contacts
@BiBi read the README for my EGtradePRO project
```

---

## Architecture

```
WhatsApp (baileys) --> SQLite --> Polling loop --> Container (Claude Agent SDK) --> Response
                                                          |
                                              /workspace/extra/projects (~/dev/CLAUDE)
```

Single Node.js process. Agents execute in isolated Docker containers with filesystem isolation. IPC via filesystem. Per-group message queue with concurrency control.

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/group-queue.ts` | Per-group queue with global concurrency limit |
| `src/container-runner.ts` | Spawns agent containers, reads `model.txt` |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/mount-security.ts` | Validates container mounts against allowlist |
| `groups/*/CLAUDE.md` | Per-group memory |
| `groups/main/dashboard-server.js` | Dashboard HTTP + WebSocket server |
| `groups/main/index.html` | Dashboard — Main tab |
| `groups/main/share.html` | Dashboard — Share tab |
| `groups/main/terminal.html` | Dashboard — Terminal tab |
| `groups/main/projects.html` | Dashboard — Projects tab |
| `model.txt` | Active model config (read on every spawn) |
| `contacts.txt` | Registered contacts (read on startup) |
| `rebuild.sh` | Full clean rebuild script |

### Service Management (macOS)

```bash
# Main NanoClaw service
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Dashboard service
launchctl load ~/Library/LaunchAgents/com.nanoclaw.dashboard.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.dashboard.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.dashboard
```

---

## Philosophy

**Small enough to understand.** One process, a few source files, no microservices. Ask Claude Code to walk you through the whole codebase.

**Secure by isolation.** Agents run in Linux containers. Bash access is safe because commands run inside the container. Mounts are validated against an external allowlist that containers cannot modify.

**Built for one person.** Not a framework. Customized for exactly how you want it. Claude Code modifies the code when you want changes.

**AI-native.** Ask BiBi or Claude Code what's happening. Describe a problem and Claude fixes it.

---

## Requirements

- macOS (this fork uses launchd for both services)
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Docker](https://docker.com/products/docker-desktop)

---

## License

MIT
