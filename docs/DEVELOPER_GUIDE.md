# Developer Guide

This guide is for contributors and maintainers working directly in this repository.

## 1) Setup Instructions

### Prerequisites

- Node.js `>=20`
- `npm`
- A container runtime:
  - Docker (default in this repo), or
  - Apple Container (if you have converted runtime support)
- WhatsApp account for auth flow

### Recommended first-time setup

```bash
git clone <your-fork-or-repo-url>
cd NanoClaw
bash setup.sh
claude
```

Then run `/setup` in Claude Code. It orchestrates environment checks, container build, WhatsApp auth, registration, service setup, and verification.

### Manual setup (without `/setup`)

1. Install dependencies:
```bash
npm install
```
2. Create `.env` with one auth credential:
```bash
CLAUDE_CODE_OAUTH_TOKEN=...
# or
ANTHROPIC_API_KEY=...
```
3. Build the agent container image:
```bash
./container/build.sh
```
4. Authenticate WhatsApp:
```bash
npm run auth
# or pairing code:
npx tsx src/whatsapp-auth.ts --pairing-code --phone 14155551234
```
5. Build and run host app:
```bash
npm run build
npm run dev
```

### Optional service setup

```bash
npx tsx setup/index.ts --step service
npx tsx setup/index.ts --step verify
```

### Optional dashboard

If your environment does not auto-manage the dashboard service, run it manually:

```bash
node groups/main/dashboard-server.js
```

Dashboard URL: `http://localhost:3838`

## 2) Project Structure Overview

### Top-level directories

- `src/` - Main runtime (message loop, DB, queue, container orchestration, channels).
- `setup/` - Modular setup steps (`environment`, `container`, `whatsapp-auth`, `service`, `verify`, etc.).
- `container/` - Container image and in-container agent runner code.
- `skills-engine/` - Skill application/update/rebase/replay engine.
- `groups/` - Per-group state and memories (`groups/<name>/CLAUDE.md`), plus dashboard files under `groups/main/`.
- `data/` - Runtime IPC and session state.
- `store/` - Persistent local state (SQLite DB, auth files).
- `docs/` - Architecture, security, troubleshooting, and spec docs.
- `dist/` - Compiled TypeScript output for runtime (`npm run build` output). Do not edit manually.

### Core runtime files

- `src/index.ts` - Main orchestrator.
- `src/channels/whatsapp.ts` - WhatsApp integration.
- `src/container-runner.ts` - Container spawn and streaming/output handling.
- `src/group-queue.ts` - Per-group queue and global container concurrency gating.
- `src/ipc.ts` - File-based IPC processing.
- `src/task-scheduler.ts` - Scheduled task execution.
- `src/db.ts` - SQLite schema and queries.

## 3) Development Workflow

### Typical loop

1. Create a branch.
2. Make changes in source (`src/`, `setup/`, `skills-engine/`, `container/agent-runner/` as needed).
3. Run quality checks:
```bash
npm run typecheck
npm test
```
4. If you changed container code (`container/` or in-container runner), rebuild image:
```bash
./container/build.sh
```
5. If you changed host runtime behavior, rebuild and restart:
```bash
npm run build
# macOS launchd:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
6. Validate behavior in logs:
```bash
tail -f logs/nanoclaw.log
```

### Contribution policy

Per `CONTRIBUTING.md`:
- Accepted in core: bug fixes, security fixes, simplifications.
- New capabilities should generally be delivered as skills, not core feature expansion.

## 4) Testing Approach

### Test framework and scope

- Framework: Vitest
- Main config (`vitest.config.ts`) includes:
  - `src/**/*.test.ts`
  - `setup/**/*.test.ts`
  - `skills-engine/**/*.test.ts`
- Skill-package config (`vitest.skills.config.ts`) includes:
  - `.claude/skills/**/tests/*.test.ts`

### Recommended execution strategy

- Run targeted tests during iteration:
```bash
npx vitest run src/db.test.ts
npx vitest run src/container-runner.test.ts
```
- Run full suite before merge:
```bash
npm test
```
- Optional skill tests:
```bash
npx vitest run --config vitest.skills.config.ts
```

### What to prioritize in tests

- Runtime behavior across queue/scheduler/container boundaries.
- DB query and migration behavior.
- Setup step correctness across platforms.
- Regression tests for bug fixes, especially message flow and auth/service lifecycle.

## 5) Common Troubleshooting Steps

### Service is not running

```bash
npx tsx setup/index.ts --step verify
launchctl list | grep nanoclaw            # macOS
systemctl --user status nanoclaw          # Linux
```

If needed:
```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
systemctl --user restart nanoclaw                   # Linux
```

### Dashboard is not reachable on :3838

```bash
lsof -i :3838
node groups/main/dashboard-server.js
tail -f logs/dashboard.log
```

### WhatsApp connected but no responses

```bash
grep -E "Connected to WhatsApp|Connection closed|New messages" logs/nanoclaw.log | tail -20
```

Check auth state:
```bash
ls -la store/auth/
npm run auth
```

Also confirm trigger format in chat (`@BiBi ...` unless your assistant name differs).

### Container agent errors/timeouts

```bash
docker info                                # or: container system status
./container/build.sh
ls -lt groups/*/logs/container-*.log | head -5
tail -n 120 groups/main/logs/container-*.log
```

### Setup failures

```bash
tail -n 200 logs/setup.log
npx tsx setup/index.ts --step environment
npx tsx setup/index.ts --step verify
```

### Useful references

- `docs/DEBUG_CHECKLIST.md` for deep diagnostics
- `docs/SECURITY.md` for mount/auth isolation details
- `docs/SPEC.md` for system behavior and data model
