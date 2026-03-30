/**
 * NanoClaw Ollama Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { SwarmManager } from './swarm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const HISTORY_FILE = '/workspace/group/.ollama-history.json';
const MAX_HISTORY_MESSAGES = 20;

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

type Message = OpenAI.Chat.ChatCompletionMessageParam;

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function sanitizeHistory(messages: Message[]): Message[] {
  // Strip leading tool messages whose assistant tool_call was truncated away
  let start = 0;
  while (start < messages.length && (messages[start] as { role: string }).role === 'tool') {
    start++;
  }
  const trimmed = messages.slice(start);

  // Also strip a trailing assistant message that has tool_calls but no following tool response
  // (session ended mid-tool-call)
  if (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1] as { role: string; tool_calls?: unknown[] };
    if (last.role === 'assistant' && last.tool_calls && last.tool_calls.length > 0) {
      return trimmed.slice(0, -1);
    }
  }

  return trimmed;
}

function loadHistory(): Message[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      if (Array.isArray(raw)) return sanitizeHistory(raw.slice(-MAX_HISTORY_MESSAGES));
    }
  } catch { /* start fresh */ }
  return [];
}

function saveHistory(history: Message[]): void {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-MAX_HISTORY_MESSAGES), null, 2));
  } catch (err) {
    log(`Failed to save history: ${err}`);
  }
}

function buildSystemPrompt(isMain: boolean, assistantName: string): string {
  const parts: string[] = [
    `You are ${assistantName}, a personal AI assistant. You have access to tools for running bash commands, reading/writing files, and managing scheduled tasks. Be concise and helpful.`,
    `Current time: ${new Date().toISOString()}`,
  ];

  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    parts.push('\n--- Group Memory ---\n' + fs.readFileSync(groupClaudeMd, 'utf-8'));
  }

  if (!isMain) {
    const globalClaudeMd = '/workspace/global/CLAUDE.md';
    if (fs.existsSync(globalClaudeMd)) {
      parts.push('\n--- Global Memory ---\n' + fs.readFileSync(globalClaudeMd, 'utf-8'));
    }
  }

  return parts.join('\n');
}

function writeIpcFile(dir: string, data: object): void {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
}

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a bash command in the container workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file (creates parent directories as needed).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to write' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories at a path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to list' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a message to the WhatsApp chat immediately (useful for progress updates).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text to send' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_task',
      description: 'Schedule a recurring or one-time task.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What the agent should do when the task runs' },
          schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'], description: 'cron=recurring at specific times, interval=every N milliseconds, once=run once' },
          schedule_value: { type: 'string', description: 'Cron expression (e.g. "0 9 * * *"), milliseconds (e.g. "3600000"), or local ISO timestamp (e.g. "2026-03-01T09:00:00")' },
          context_mode: { type: 'string', enum: ['group', 'isolated'], description: 'group=use chat history, isolated=fresh session' },
        },
        required: ['prompt', 'schedule_type', 'schedule_value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tasks',
      description: 'List all scheduled tasks.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_task',
      description: 'Cancel and delete a scheduled task.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'The task ID to cancel' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_worker',
      description: 'Spawn a PicoClaw subagent to work on a task in parallel. Returns immediately with a worker_id. Max 3 concurrent workers. Use poll_worker() to get results.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task for the worker to execute' },
          context: { type: 'string', description: 'Optional background context to give the worker' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'poll_worker',
      description: 'Check the status of a spawned worker and get its result when done. Call repeatedly until status is "done" or "error".',
      parameters: {
        type: 'object',
        properties: {
          worker_id: { type: 'string', description: 'The worker_id returned by spawn_worker' },
        },
        required: ['worker_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_workers',
      description: 'List all active and recently completed PicoClaw workers.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function executeTool(
  name: string,
  args: Record<string, unknown>,
  chatJid: string,
  groupFolder: string,
  isMain: boolean,
  swarm: SwarmManager,
): string {
  try {
    switch (name) {
      case 'bash': {
        try {
          const output = execSync(String(args.command), {
            cwd: '/workspace/group',
            timeout: 30000,
            encoding: 'utf-8',
          });
          return output.trim() || '(no output)';
        } catch (err: unknown) {
          const e = err as { message: string; stderr?: string };
          return `Error: ${e.message}\n${e.stderr || ''}`.trim();
        }
      }

      case 'read_file': {
        const content = fs.readFileSync(String(args.path), 'utf-8');
        return content.length > 8000 ? content.slice(0, 8000) + '\n...(truncated)' : content;
      }

      case 'write_file': {
        const filePath = String(args.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, String(args.content));
        return 'File written.';
      }

      case 'list_directory': {
        const entries = fs.readdirSync(String(args.path), { withFileTypes: true });
        return entries.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n') || '(empty)';
      }

      case 'send_message': {
        writeIpcFile(MESSAGES_DIR, {
          type: 'message',
          chatJid,
          text: String(args.text),
          groupFolder,
          timestamp: new Date().toISOString(),
        });
        return 'Message sent.';
      }

      case 'schedule_task': {
        writeIpcFile(TASKS_DIR, {
          type: 'schedule_task',
          prompt: String(args.prompt),
          schedule_type: String(args.schedule_type),
          schedule_value: String(args.schedule_value),
          context_mode: String(args.context_mode || 'isolated'),
          targetJid: chatJid,
          createdBy: groupFolder,
          timestamp: new Date().toISOString(),
        });
        return `Task scheduled: ${args.schedule_type} - ${args.schedule_value}`;
      }

      case 'list_tasks': {
        const tasksFile = path.join(IPC_DIR, 'current_tasks.json');
        if (!fs.existsSync(tasksFile)) return 'No scheduled tasks.';
        const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
        const visible = isMain
          ? tasks
          : tasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);
        if (visible.length === 0) return 'No scheduled tasks.';
        return visible.map((t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
          `[${t.id}] ${t.prompt.slice(0, 50)} (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`
        ).join('\n');
      }

      case 'cancel_task': {
        writeIpcFile(TASKS_DIR, {
          type: 'cancel_task',
          taskId: String(args.task_id),
          groupFolder,
          isMain,
          timestamp: new Date().toISOString(),
        });
        return `Task ${args.task_id} cancellation requested.`;
      }

      case 'spawn_worker': {
        const result = swarm.spawn(String(args.task), args.context ? String(args.context) : undefined);
        return result.error
          ? `Error: ${result.error}`
          : `Worker spawned. worker_id: ${result.worker_id}. Use poll_worker("${result.worker_id}") to check status.`;
      }

      case 'poll_worker': {
        const r = swarm.poll(String(args.worker_id));
        if (r.error) return `Error: ${r.error}`;
        const elapsed = ((r.elapsed_ms || 0) / 1000).toFixed(1);
        if (r.status === 'running') return `Status: running (${elapsed}s elapsed). Check again later.`;
        return `Status: ${r.status} (${elapsed}s)\n\n${r.result}`;
      }

      case 'list_workers': {
        const workers = swarm.list();
        if (workers.length === 0) return 'No active or recent workers.';
        return workers.map((w) =>
          `[${w.id}] ${w.status.toUpperCase()} (${(w.elapsed_ms / 1000).toFixed(1)}s): ${w.task_preview}`
        ).join('\n');
      }

      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err: unknown) {
    const e = err as { message?: string };
    return `Tool error: ${e.message || String(err)}`;
  }
}

async function runAgent(
  input: ContainerInput,
  ollama: OpenAI,
  primaryModel: string,
  fallbackModel: string,
): Promise<string> {
  const systemPrompt = buildSystemPrompt(input.isMain, input.assistantName || 'BiBi');
  const history = loadHistory();
  const swarm = new SwarmManager();

  let prompt = input.prompt;
  if (input.isScheduledTask) {
    prompt = `[SCHEDULED TASK - not sent directly by a user]\n\n${prompt}`;
  }

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: prompt },
  ];

  let model = primaryModel;
  let triedFallback = false;

  while (true) {
    let completion: OpenAI.Chat.ChatCompletion;

    try {
      completion = await ollama.chat.completions.create({
        model,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
      });
    } catch (err: unknown) {
      const e = err as { message?: string; status?: number };
      const msg = (e.message || String(err)).toLowerCase();
      if (!triedFallback && model === primaryModel && (msg.includes('model') || msg.includes('not found') || e.status === 404)) {
        log(`Primary model "${primaryModel}" unavailable, falling back to "${fallbackModel}"`);
        model = fallbackModel;
        triedFallback = true;
        continue;
      }
      throw err;
    }

    const message = completion.choices[0].message;
    messages.push(message as Message);

    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        log(`Tool: ${toolCall.function.name}`);
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(toolCall.function.arguments); } catch { /* use empty */ }

        const result = executeTool(
          toolCall.function.name, args, input.chatJid, input.groupFolder, input.isMain, swarm,
        );

        messages.push({ role: 'tool', content: result, tool_call_id: toolCall.id, name: toolCall.function.name } as Message);
      }
    } else {
      const response = message.content || '';
      // Save history without system message
      saveHistory(messages.slice(1) as Message[]);
      return response;
    }
  }
}

async function main(): Promise<void> {
  let input: ContainerInput;

  try {
    const stdinData = await readStdin();
    input = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Input received for group: ${input.groupFolder}`);
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: `Failed to parse input: ${err}` });
    process.exit(1);
  }

  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434/v1';
  const primaryModel = process.env.OLLAMA_MODEL || 'qwen3-coder-next:cloud';
  const fallbackModel = process.env.OLLAMA_FALLBACK_MODEL || 'llama3.2';

  log(`Ollama: ${ollamaBaseUrl}, model: ${primaryModel} (fallback: ${fallbackModel})`);

  const ollama = new OpenAI({
    baseURL: ollamaBaseUrl,
    apiKey: 'ollama',
  });

  try {
    const result = await runAgent(input, ollama, primaryModel, fallbackModel);
    log(`Done, response: ${result.length} chars`);
    writeOutput({
      status: 'success',
      result: result || null,
      newSessionId: input.groupFolder,
    });
  } catch (err: unknown) {
    const e = err as { message?: string };
    const errorMsg = e.message || String(err);
    log(`Agent error: ${errorMsg}`);
    writeOutput({ status: 'error', result: null, error: errorMsg });
    process.exit(1);
  }
}

main();
