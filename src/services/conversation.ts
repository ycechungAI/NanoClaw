import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  SESSION_MAX_AGE_MS,
  TRIGGER_PATTERN,
} from '../config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from '../container-runner.js';
import {
  deleteSession,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getRouterState,
  setRegisteredGroup,
  setRouterState,
  setSession,
} from '../db.js';
import { GroupQueue } from '../group-queue.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { formatMessages } from '../router.js';
import { Channel, RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';

export interface AllowedSendersState {
  enabled: boolean;
  senders: string[];
  senderSet: Set<string>;
}

export class ConversationService {
  public sessions: Record<string, string> = {};
  public registeredGroups: Record<string, RegisteredGroup> = {};
  public lastAgentTimestamp: Record<string, string> = {};

  constructor(
    private queue: GroupQueue,
    private getChannel: (jid: string) => Channel | undefined,
    private getAllowedSendersState: () => AllowedSendersState,
  ) {}

  public loadState(): void {
    const agentTs = getRouterState('last_agent_timestamp');
    try {
      this.lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
    } catch {
      logger.warn('Corrupted last_agent_timestamp in DB, resetting');
      this.lastAgentTimestamp = {};
    }
    this.sessions = getAllSessions();
    this.registeredGroups = getAllRegisteredGroups();
    logger.info(
      { groupCount: Object.keys(this.registeredGroups).length },
      'Conversation state loaded',
    );
  }

  public saveState(): void {
    setRouterState(
      'last_agent_timestamp',
      JSON.stringify(this.lastAgentTimestamp),
    );
  }

  public registerGroup(jid: string, group: RegisteredGroup): void {
    let groupDir: string;
    try {
      groupDir = resolveGroupFolderPath(group.folder);
    } catch (err) {
      logger.warn(
        { jid, folder: group.folder, err },
        'Rejecting group registration with invalid folder',
      );
      return;
    }

    this.registeredGroups[jid] = group;
    setRegisteredGroup(jid, group);

    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    logger.info(
      { jid, name: group.name, folder: group.folder },
      'Group registered',
    );
  }

  public getAvailableGroups(): import('../container-runner.js').AvailableGroup[] {
    const chats = getAllChats();
    const registeredJids = new Set(Object.keys(this.registeredGroups));

    return chats
      .filter((c) => c.jid !== '__group_sync__' && c.is_group)
      .map((c) => ({
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid),
      }));
  }

  public _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
    this.registeredGroups = groups;
  }

  public async processGroupMessages(chatJid: string): Promise<boolean> {
    const group = this.registeredGroups[chatJid];
    if (!group) return true;

    const channel = this.getChannel(chatJid);
    if (!channel) {
      console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
      return true;
    }

    const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
    const sinceTimestamp = this.lastAgentTimestamp[chatJid] || '';

    if (this.sessions[group.folder] && sinceTimestamp) {
      const lastUsed = new Date(sinceTimestamp).getTime();
      if (!isNaN(lastUsed) && Date.now() - lastUsed > SESSION_MAX_AGE_MS) {
        logger.info(
          { group: group.name },
          'Session expired, starting fresh to save tokens',
        );
        delete this.sessions[group.folder];
        deleteSession(group.folder);
      }
    }

    let missedMessages = getMessagesSince(
      chatJid,
      sinceTimestamp,
      ASSISTANT_NAME,
    );

    const allowedSendersState = this.getAllowedSendersState();
    if (isMainGroup && allowedSendersState.enabled) {
      const filtered = missedMessages.filter((msg) =>
        allowedSendersState.senderSet.has(msg.sender),
      );

      if (filtered.length < missedMessages.length) {
        logger.info(
          {
            total: missedMessages.length,
            filtered: filtered.length,
            blocked: missedMessages.length - filtered.length,
          },
          'Filtered messages by allowed senders',
        );
      }

      missedMessages = filtered;
    }

    if (missedMessages.length === 0) return true;
    
    if (group.requiresTrigger !== false) {
      const hasTrigger = missedMessages.some((m) =>
        TRIGGER_PATTERN.test(m.content.trim()),
      );
      if (!hasTrigger) return true;
    }

    const prompt = formatMessages(missedMessages);
    const previousCursor = this.lastAgentTimestamp[chatJid] || '';
    this.lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;
    this.saveState();

    logger.info(
      { group: group.name, messageCount: missedMessages.length },
      'Processing messages',
    );

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.debug(
          { group: group.name },
          'Idle timeout, closing container stdin',
        );
        this.queue.closeStdin(chatJid);
      }, IDLE_TIMEOUT);
    };

    await channel.setTyping?.(chatJid, true);
    let hadError = false;
    let outputSentToUser = false;

    const output = await this.runAgent(group, prompt, chatJid, async (result) => {
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
        if (text) {
          await channel.sendMessage(chatJid, text);
          outputSentToUser = true;
        }
        resetIdleTimer();
      }

      if (result.status === 'success') {
        this.queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    });

    await channel.setTyping?.(chatJid, false);
    if (idleTimer) clearTimeout(idleTimer);

    if (output === 'error' || hadError) {
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }
      this.lastAgentTimestamp[chatJid] = previousCursor;
      this.saveState();
      logger.warn(
        { group: group.name },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    return true;
  }

  public async runAgent(
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<'success' | 'error'> {
    const isMain = group.folder === MAIN_GROUP_FOLDER;
    const sessionId = this.sessions[group.folder];

    const tasks = getAllTasks();
    writeTasksSnapshot(
      group.folder,
      isMain,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );

    const availableGroups = this.getAvailableGroups();
    writeGroupsSnapshot(
      group.folder,
      isMain,
      availableGroups,
      new Set(Object.keys(this.registeredGroups)),
    );

    const wrappedOnOutput = onOutput
      ? async (output: ContainerOutput) => {
          if (output.newSessionId) {
            this.sessions[group.folder] = output.newSessionId;
            setSession(group.folder, output.newSessionId);
          }
          await onOutput(output);
        }
      : undefined;

    try {
      const output = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain,
          assistantName: ASSISTANT_NAME,
        },
        (proc, containerName) =>
          this.queue.registerProcess(chatJid, proc, containerName, group.folder),
        wrappedOnOutput,
      );

      if (output.newSessionId) {
        this.sessions[group.folder] = output.newSessionId;
        setSession(group.folder, output.newSessionId);
      }

      if (output.status === 'error') {
        logger.error(
          { group: group.name, error: output.error },
          'Container agent error',
        );
        return 'error';
      }

      return 'success';
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');
      return 'error';
    }
  }
}
