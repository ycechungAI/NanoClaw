# Plan: PicoClaw Agent Swarm

## Goal
Add 3 PicoClaw subagent workers that the main BiBi agent can spawn on-demand
from within its container to execute tasks in parallel. Workers are ultra-lightweight
(~10MB, ~1s startup), run as subprocesses inside the existing container, and
auto-cleanup after completion.

## Architecture
```
[WhatsApp] → [BiBi container]
                  │
                  ├── spawn_worker("research X") ──→ [PicoClaw Worker 1] → result
                  ├── spawn_worker("download Y") ──→ [PicoClaw Worker 2] → result
                  └── spawn_worker("analyze Z")  ──→ [PicoClaw Worker 3] → result
                            (max 3 concurrent, subprocesses inside same container)
```

BiBi stays completely unchanged — it just gets 3 new tools.

---

## Files Changed

| File | Change |
|------|--------|
| `container/Dockerfile` | Download PicoClaw binary (multi-arch) |
| `container/agent-runner/src/swarm.ts` | **New** — SwarmManager class |
| `container/agent-runner/src/index.ts` | Add 3 swarm tools + instantiate SwarmManager |

---

## 1. container/Dockerfile

Add after existing apt-get step:

```dockerfile
# Download PicoClaw binary (multi-arch)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then PC_ARCH="x86_64"; \
    elif [ "$ARCH" = "arm64" ]; then PC_ARCH="arm64"; \
    else echo "Unsupported arch: $ARCH" && exit 1; fi && \
    curl -fsSL \
      "https://github.com/sipeed/picoclaw/releases/download/v0.1.2/picoclaw_Linux_${PC_ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin/ picoclaw && \
    chmod +x /usr/local/bin/picoclaw
```

---

## 2. container/agent-runner/src/swarm.ts (new file)

### Worker state interface
```typescript
interface WorkerState {
  id: string;
  task: string;
  process: ChildProcess;
  startTime: number;
  stdout: string;
  stderr: string;
  status: 'running' | 'done' | 'error';
  result?: string;
  exitCode?: number;
}
```

### SwarmManager class
- `MAX_WORKERS = 3`
- `spawn(task, context?)` → `{worker_id}` or `{error: "worker pool full"}`
  - Generates PicoClaw config on first call (lazy init from env vars)
  - Creates isolated workspace `/tmp/swarm/{id}/`
  - Runs: `picoclaw agent -m "{task}" [--context "..."]`
  - 10-minute timeout per worker
- `poll(id)` → `{status, result?, elapsed_ms}` or `{error}`
- `list()` → `[{id, task_preview, status, elapsed_ms}]`
- `cleanup()` — internal, removes completed workers >5 min old

### PicoClaw config (lazy-generated at `/home/node/.picoclaw/config.json`)
Generated once from container env vars (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`):
```json
{
  "model_list": [
    {
      "model_name": "worker",
      "model": "${OLLAMA_MODEL}",
      "api_base": "${OLLAMA_BASE_URL}",
      "api_key": "ollama"
    }
  ],
  "agents": {
    "model_name": "worker",
    "workspace": "/tmp/picoclaw-work"
  }
}
```

---

## 3. container/agent-runner/src/index.ts

### New tools added to TOOLS array

```
spawn_worker(task: string, context?: string)
  Spawn a PicoClaw subagent to work on a task in parallel.
  Returns a worker_id immediately. Max 3 concurrent workers.
  context: optional background info to give the worker.

poll_worker(worker_id: string)
  Check status of a worker. Call repeatedly until status is "done" or "error".
  Returns: {status: "running"|"done"|"error", result?, elapsed_ms}

list_workers()
  List all active and recently completed workers.
  Returns: [{id, task_preview, status, elapsed_ms}]
```

### Wiring
- Create `new SwarmManager()` at top of `main()`
- Pass swarm instance into `executeTool()`
- Add `case 'spawn_worker'`, `case 'poll_worker'`, `case 'list_workers'` to switch

---

## Usage Example

BiBi can now do things like:

```
User: @bibi search for the latest news on AI and summarize it for joshua

BiBi:
  → spawn_worker("Search for latest AI news from the past 24h, return top 5 headlines with summaries")
  → spawn_worker("Find Joshua's preferences about news topics from group memory")
  → [waits, polling both]
  → combines results → responds
```

Or for long tasks:
```
  → spawn_worker("Download and analyze the PDF at URL X, return key findings")
  → continues doing other work while worker runs
  → poll_worker(id) when ready
```

---

## Rebuild

After implementation: `./container/build.sh`
