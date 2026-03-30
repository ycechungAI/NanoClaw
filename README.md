<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  Personal AI assistant (BiBi) — runs Claude agents in isolated containers, reachable via WhatsApp
</p>

<p align="center">
  <a href="https://nanoclaw.dev">nanoclaw.dev</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="https://discord.gg/VDdww8qS42"><img src="https://img.shields.io/discord/1470188214710046894?label=Discord&logo=discord&v=2" alt="Discord" valign="middle"></a>
</p>

This is a personal fork of [NanoClaw](https://github.com/qwibitai/NanoClaw). The assistant is named **BiBi** and responds to `@BiBi` (case-insensitive) in any WhatsApp chat.

---

## Quick Start

```bash
git clone <your-fork>
cd NanoClaw
./start.sh
```

`start.sh` handles everything automatically:
- Fixes Docker configuration
- Installs dependencies
- Builds TypeScript
- Builds the agent container image
- Starts launchd services

Then run `/setup` in Claude Code for WhatsApp authentication.

The dashboard auto-starts at **http://localhost:3838**.

---

## What It Does

- **WhatsApp integration** — Message BiBi from any chat using `@BiBi`
- **Containerized agents** — Each conversation runs in an isolated Linux VM
- **Scheduled tasks** — Set reminders and recurring tasks that execute as full Claude agents
- **Web dashboard** — Live stats, chat interface, file manager, and browser terminal
- **Project access** — BiBi can read/edit files in `~/dev/CLAUDE/` from any chat

---

## Dashboard

Access at **http://localhost:3838**. Four tabs:

| Tab | Description |
|-----|-------------|
| **Main** | Live stats, recent messages, built-in chat with model selector |
| **Share** | File manager for exchanging files with BiBi |
| **Terminal** | Full browser terminal (xterm.js + node-pty) |
| **Projects** | Browse `~/dev/CLAUDE/` projects, cd directly from browser |

### Service Management

```bash
# Start/stop dashboard
launchctl load ~/Library/LaunchAgents/com.nanoclaw.dashboard.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.dashboard.plist

# Restart
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.dashboard

# Logs
tail -f logs/dashboard.log
tail -f logs/dashboard.error.log
```

---

## Configuration

### `model.txt` — AI Model Selection

Read on every container spawn (no restart needed):

```
# Line 1: primary model
# Line 2: fallback model
# Line 3+: additional options (shown in dashboard dropdown)
gemini-3-flash-preview:cloud
llama3.2
qwen3-coder-next:cloud
```

### `contacts.txt` — Registered WhatsApp Contacts

Add contacts who can trigger BiBi:

```
# Format: phone_number | display_name | folder_name
11234567890 | main          | main
11234567891 | Alice Smith   | alice-smith
```

Each contact gets an isolated container and memory file at `groups/<folder>/CLAUDE.md`.

---

## Usage Examples

From any WhatsApp chat:

```
@BiBi what's the weather today
@BiBi summarize the last 10 messages
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
WhatsApp (baileys) → SQLite → Polling Loop → Container (Claude Agent SDK) → Response
                                                    │
                                      /workspace/extra/projects (~/dev/CLAUDE)
```

Single Node.js process. Agents execute in isolated containers with filesystem isolation.

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entrypoint |
| `src/services/runtime-coordinator.ts` | Orchestrator |
| `src/services/message-ingestion.ts` | Message ingestion and triggers |
| `src/channels/whatsapp.ts` | WhatsApp connection |
| `src/container-runner.ts` | Spawns agent containers |
| `src/task-scheduler.ts` | Scheduled task execution |
| `src/db.ts` | SQLite operations |
| `groups/*/CLAUDE.md` | Per-group memory |
| `groups/main/dashboard-server.js` | Dashboard server |

---

## Development

```bash
npm run dev          # Run with hot reload (tsx)
npm run build        # Compile TypeScript
npm run start        # Run compiled JS
./rebuild.sh         # Full clean rebuild (container + TypeScript)
./start.sh           # Auto-build and start all services
```

### Service Management (macOS)

```bash
# Main NanoClaw service
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Logs
tail -f logs/nanoclaw.log
```

---

## Philosophy

**Small enough to understand** — One process, a few source files, no microservices. Ask Claude Code to walk you through the entire codebase.

**Secure by isolation** — Agents run in Linux containers. Bash access is safe because commands run inside the container. Mounts are validated against an external allowlist.

**Built for one person** — Not a framework. Customized for exactly how you want it. Claude Code modifies the code when you want changes.

**AI-native** — Ask BiBi or Claude Code what's happening. Describe a problem and Claude fixes it.

---

## Requirements

- macOS (uses launchd for services)
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Docker Desktop](https://docker.com/products/docker-desktop)

---

## License

MIT
