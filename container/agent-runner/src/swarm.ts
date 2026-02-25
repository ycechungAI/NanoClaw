/**
 * PicoClaw Swarm Manager
 * Manages up to 3 lightweight PicoClaw subagent workers running in parallel.
 * Workers are subprocesses inside the current container (~10MB each, ~1s startup).
 */

import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

const MAX_WORKERS = 3;
const WORKER_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const CLEANUP_AFTER_MS = 5 * 60 * 1000;   // keep completed workers 5 min for polling

interface WorkerState {
  id: string;
  task: string;
  process: ChildProcess;
  startTime: number;
  stdout: string;
  stderr: string;
  status: 'running' | 'done' | 'error';
  result?: string;
  completedAt?: number;
  timeoutHandle?: ReturnType<typeof setTimeout>;
}

export interface WorkerInfo {
  id: string;
  task_preview: string;
  status: 'running' | 'done' | 'error';
  elapsed_ms: number;
}

export interface SpawnResult {
  worker_id?: string;
  error?: string;
}

export interface PollResult {
  status?: 'running' | 'done' | 'error';
  result?: string;
  elapsed_ms?: number;
  error?: string;
}

export class SwarmManager {
  private workers: Map<string, WorkerState> = new Map();
  private configInitialized = false;
  private readonly configPath = '/home/node/.picoclaw/config.json';

  private activeCount(): number {
    let count = 0;
    for (const w of this.workers.values()) {
      if (w.status === 'running') count++;
    }
    return count;
  }

  private initConfig(): void {
    if (this.configInitialized) return;

    const baseUrl = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1';
    const model = process.env.OLLAMA_MODEL || 'llama3.2';

    const config = {
      model_list: [
        {
          model_name: 'worker',
          model,
          api_base: baseUrl,
          api_key: 'ollama',
        },
      ],
      agents: {
        model_name: 'worker',
        workspace: '/tmp/picoclaw-work',
      },
    };

    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    this.configInitialized = true;
  }

  spawn(task: string, context?: string): SpawnResult {
    this.cleanup();

    const active = this.activeCount();
    if (active >= MAX_WORKERS) {
      return { error: `Worker pool full (${active}/${MAX_WORKERS} running). Wait for a worker to finish.` };
    }

    try {
      this.initConfig();
    } catch (err) {
      return { error: `Failed to initialize PicoClaw config: ${err}` };
    }

    const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const workspace = `/tmp/swarm/${id}`;
    fs.mkdirSync(workspace, { recursive: true });

    const taskWithContext = context ? `[Context: ${context}]\n\n${task}` : task;

    const proc = spawn('picoclaw', ['agent', '-m', taskWithContext], {
      cwd: workspace,
      env: { ...process.env, HOME: '/home/node' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const state: WorkerState = {
      id,
      task,
      process: proc,
      startTime: Date.now(),
      stdout: '',
      stderr: '',
      status: 'running',
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      state.stdout += chunk.toString();
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      state.stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
      state.completedAt = Date.now();
      if (code === 0) {
        state.status = 'done';
        state.result = state.stdout.trim() || '(no output)';
      } else {
        state.status = 'error';
        state.result = `Exit code ${code}. ${(state.stderr || state.stdout).trim()}`.trim();
      }
    });

    proc.on('error', (err) => {
      if (state.timeoutHandle) clearTimeout(state.timeoutHandle);
      state.completedAt = Date.now();
      state.status = 'error';
      state.result = `Failed to start picoclaw: ${err.message}`;
    });

    state.timeoutHandle = setTimeout(() => {
      if (state.status === 'running') {
        proc.kill('SIGKILL');
        state.status = 'error';
        state.result = `Timed out after ${WORKER_TIMEOUT_MS / 60000} minutes.`;
        state.completedAt = Date.now();
      }
    }, WORKER_TIMEOUT_MS);

    this.workers.set(id, state);
    return { worker_id: id };
  }

  poll(id: string): PollResult {
    const w = this.workers.get(id);
    if (!w) return { error: `Worker ${id} not found (may have been cleaned up).` };

    return {
      status: w.status,
      result: w.status !== 'running' ? w.result : undefined,
      elapsed_ms: Date.now() - w.startTime,
    };
  }

  list(): WorkerInfo[] {
    this.cleanup();
    return Array.from(this.workers.values()).map((w) => ({
      id: w.id,
      task_preview: w.task.length > 60 ? w.task.slice(0, 60) + '...' : w.task,
      status: w.status,
      elapsed_ms: Date.now() - w.startTime,
    }));
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, w] of this.workers.entries()) {
      if (w.status !== 'running' && w.completedAt && now - w.completedAt > CLEANUP_AFTER_MS) {
        // Clean up temp workspace
        try { fs.rmSync(`/tmp/swarm/${id}`, { recursive: true, force: true }); } catch { /* ignore */ }
        this.workers.delete(id);
      }
    }
  }
}
