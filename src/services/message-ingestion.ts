import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from '../config.js';
import {
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getTriggerMessagesFromAllChats,
  setRouterState,
} from '../db.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { GroupQueue } from '../group-queue.js';
import { formatMessages } from '../router.js';
import { Channel, NewMessage } from '../types.js';
import { logger } from '../logger.js';
import { ConversationService, AllowedSendersState } from './conversation.js';

const ALLOWED_SENDERS_REFRESH_DEBOUNCE_MS = 200;
const ALLOWED_SENDERS_REFRESH_INTERVAL_MS = 60_000;

export class MessageIngestionService {
  private lastTimestamp = '';
  private processingMessages = false;
  private messageLoopQueued = false;
  private pendingAnyChatJids = new Set<string>();

  public allowedSendersState: AllowedSendersState = {
    enabled: false,
    senders: [],
    senderSet: new Set<string>(),
  };

  private allowedSendersWatcher: fs.FSWatcher | null = null;
  private allowedSendersRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private allowedSendersRefreshInFlight: Promise<void> | null = null;

  constructor(
    private conversation: ConversationService,
    private queue: GroupQueue,
    private getChannel: (jid: string) => Channel | undefined,
  ) {}

  public loadState(): void {
    this.lastTimestamp = getRouterState('last_timestamp') || '';
  }

  public saveState(): void {
    setRouterState('last_timestamp', this.lastTimestamp);
  }

  private getAllowedSendersPath(): string {
    return path.join(
      resolveGroupFolderPath(MAIN_GROUP_FOLDER),
      'allowed_senders.json',
    );
  }

  private setAllowedSendersState(next: { enabled: boolean; senders: string[] }): void {
    this.allowedSendersState.enabled = next.enabled;
    this.allowedSendersState.senders = next.senders;
    this.allowedSendersState.senderSet = new Set(next.senders);
  }

  public async refreshAllowedSendersConfig(): Promise<void> {
    if (this.allowedSendersRefreshInFlight) {
      return this.allowedSendersRefreshInFlight;
    }

    this.allowedSendersRefreshInFlight = (async () => {
      const allowedSendersPath = this.getAllowedSendersPath();
      try {
        const raw = await fs.promises.readFile(allowedSendersPath, 'utf-8');
        const parsed = JSON.parse(raw) as {
          enabled?: boolean;
          allowedSenders?: unknown;
        };

        if (!parsed.enabled || !Array.isArray(parsed.allowedSenders)) {
          this.setAllowedSendersState({ enabled: false, senders: [] });
          return;
        }

        const senders = Array.from(
          new Set(
            parsed.allowedSenders
              .map((v) => (typeof v === 'string' ? v.trim() : ''))
              .filter(Boolean),
          ),
        );
        this.setAllowedSendersState({ enabled: true, senders });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'ENOENT') {
          logger.warn({ err }, 'Failed to refresh allowed_senders.json');
        }
        this.setAllowedSendersState({ enabled: false, senders: [] });
      }
    })().finally(() => {
      this.allowedSendersRefreshInFlight = null;
    });

    return this.allowedSendersRefreshInFlight;
  }

  private scheduleAllowedSendersRefresh(): void {
    if (this.allowedSendersRefreshTimer) clearTimeout(this.allowedSendersRefreshTimer);
    this.allowedSendersRefreshTimer = setTimeout(() => {
      this.refreshAllowedSendersConfig().catch((err) =>
        logger.warn({ err }, 'Allowed senders refresh failed'),
      );
    }, ALLOWED_SENDERS_REFRESH_DEBOUNCE_MS);
  }

  public startAllowedSendersWatcher(): void {
    const mainGroupDir = resolveGroupFolderPath(MAIN_GROUP_FOLDER);
    fs.mkdirSync(mainGroupDir, { recursive: true });

    if (!this.allowedSendersWatcher) {
      try {
        this.allowedSendersWatcher = fs.watch(mainGroupDir, (_eventType, filename) => {
          if (!filename || filename.toString() === 'allowed_senders.json') {
            this.scheduleAllowedSendersRefresh();
          }
        });
      } catch (err) {
        logger.warn(
          { err, mainGroupDir },
          'Failed to watch main group directory for allowed senders updates',
        );
      }
    }

    setInterval(() => {
      this.refreshAllowedSendersConfig().catch((err) =>
        logger.warn({ err }, 'Periodic allowed senders refresh failed'),
      );
    }, ALLOWED_SENDERS_REFRESH_INTERVAL_MS);
  }

  public recoverPendingMessages(): void {
    for (const chatJid of Object.keys(this.conversation.lastAgentTimestamp)) {
      const group = this.conversation.registeredGroups[chatJid];
      const sinceTimestamp = this.conversation.lastAgentTimestamp[chatJid] || '';
      const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
      if (pending.length > 0) {
        if (group) {
          logger.info(
            { group: group.name, pendingCount: pending.length },
            'Recovery: found unprocessed messages',
          );
          this.queue.enqueueMessageCheck(chatJid);
        } else {
          logger.info(
            { chatJid, pendingCount: pending.length },
            'Recovery: found unprocessed unregistered chat messages',
          );
          this.pendingAnyChatJids.add(chatJid);
        }
      }
    }
  }

  public wakeMessageLoop(): void {
    if (this.processingMessages) {
      this.messageLoopQueued = true;
      return;
    }
    this.processMessages().catch((err) => {
      logger.error({ err }, 'Error in message processing');
    });
  }

  public async startMessageLoop(): Promise<void> {
    logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);
    this.wakeMessageLoop();
    // Poll periodically to catch messages from non-WhatsApp sources (e.g. dashboard)
    setInterval(() => this.wakeMessageLoop(), POLL_INTERVAL);
  }

  private async processMessages(): Promise<void> {
    this.processingMessages = true;

    try {
      do {
        this.messageLoopQueued = false;
        
        const jids = Object.keys(this.conversation.registeredGroups);
        const { messages, newTimestamp } = getNewMessages(
          jids,
          this.lastTimestamp,
          ASSISTANT_NAME,
        );

        let nextTimestamp = newTimestamp;
        let anyChatTriggers: NewMessage[] = [];

        if (
          this.allowedSendersState.enabled &&
          this.allowedSendersState.senders.length > 0
        ) {
          anyChatTriggers = getTriggerMessagesFromAllChats(
            this.lastTimestamp,
            this.allowedSendersState.senders,
            jids,
            ASSISTANT_NAME,
          );
          for (const msg of anyChatTriggers) {
            if (msg.timestamp > nextTimestamp) {
              nextTimestamp = msg.timestamp;
            }
            this.pendingAnyChatJids.add(msg.chat_jid);
          }
        }

        if (messages.length > 0 || anyChatTriggers.length > 0) {
          logger.info(
            { count: messages.length, anyChatCount: anyChatTriggers.length },
            'New messages',
          );

          this.lastTimestamp = nextTimestamp;
          this.saveState();

          const messagesByGroup = new Map<string, NewMessage[]>();
          for (const msg of messages) {
            const existing = messagesByGroup.get(msg.chat_jid);
            if (existing) {
              existing.push(msg);
            } else {
              messagesByGroup.set(msg.chat_jid, [msg]);
            }
          }

          for (const [chatJid, groupMessages] of messagesByGroup) {
            const group = this.conversation.registeredGroups[chatJid];
            if (!group) continue;

            const channel = this.getChannel(chatJid);
            if (!channel) {
              console.log(
                `Warning: no channel owns JID ${chatJid}, skipping messages`,
              );
              continue;
            }

            const needsTrigger = group.requiresTrigger !== false;
            if (needsTrigger) {
              const hasTrigger = groupMessages.some((m) =>
                TRIGGER_PATTERN.test(m.content.trim()),
              );
              if (!hasTrigger) continue;
            }

            const allPending = getMessagesSince(
              chatJid,
              this.conversation.lastAgentTimestamp[chatJid] || '',
              ASSISTANT_NAME,
            );
            const messagesToSend =
              allPending.length > 0 ? allPending : groupMessages;
            const formatted = formatMessages(messagesToSend);

            if (this.queue.sendMessage(chatJid, formatted)) {
              logger.debug(
                { chatJid, count: messagesToSend.length },
                'Piped messages to active container',
              );
              this.conversation.lastAgentTimestamp[chatJid] =
                messagesToSend[messagesToSend.length - 1].timestamp;
              this.conversation.saveState();
              channel
                .setTyping?.(chatJid, true)
                ?.catch((err) =>
                  logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
                );
            } else {
              this.queue.enqueueMessageCheck(chatJid);
            }
          }
        }

        await this.processAnyChatTriggers();
      } while (this.messageLoopQueued);
    } finally {
      this.processingMessages = false;
    }
  }

  private async processAnyChatTriggers(): Promise<void> {
    const mainGroupJid = Object.keys(this.conversation.registeredGroups).find(
      (jid) => this.conversation.registeredGroups[jid].folder === MAIN_GROUP_FOLDER,
    );
    if (!mainGroupJid) return;

    const mainGroup = this.conversation.registeredGroups[mainGroupJid];
    if (!this.allowedSendersState.enabled || this.allowedSendersState.senderSet.size === 0)
      return;

    if (this.pendingAnyChatJids.size === 0) return;

    for (const chatJid of Array.from(this.pendingAnyChatJids)) {
      if (this.queue.isActive(chatJid)) continue;

      const channel = this.getChannel(chatJid);
      if (!channel) continue;

      const msgs = getMessagesSince(
        chatJid,
        this.conversation.lastAgentTimestamp[chatJid] || '',
        ASSISTANT_NAME,
      );
      const validMsgs = msgs.filter(
        (m) =>
          !m.is_bot_message &&
          this.allowedSendersState.senderSet.has(m.sender) &&
          TRIGGER_PATTERN.test(m.content.trim()),
      );

      if (validMsgs.length === 0) {
        this.pendingAnyChatJids.delete(chatJid);
        continue;
      }

      this.pendingAnyChatJids.delete(chatJid);

      const prompt = formatMessages(validMsgs);
      const previousCursor = this.conversation.lastAgentTimestamp[chatJid] || '';
      this.conversation.lastAgentTimestamp[chatJid] = validMsgs[validMsgs.length - 1].timestamp;
      this.conversation.saveState();

      logger.info(
        { chatJid, count: validMsgs.length },
        'Processing @BiBi trigger from unregistered chat',
      );

      let outputSentToUser = false;
      await channel.setTyping?.(chatJid, true);
      const output = await this.conversation.runAgent(
        mainGroup,
        prompt,
        chatJid,
        async (result) => {
          if (result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            const text = raw
              .replace(/<internal>[\s\S]*?<\/internal>/g, '')
              .trim();
            if (text) {
              outputSentToUser = true;
              await channel.sendMessage(chatJid, text);
            }
          }
        },
      );
      await channel.setTyping?.(chatJid, false);

      if (output === 'error' && !outputSentToUser) {
        this.conversation.lastAgentTimestamp[chatJid] = previousCursor;
        this.conversation.saveState();
        this.pendingAnyChatJids.add(chatJid);
        logger.warn(
          { chatJid },
          'Retrying @BiBi trigger from unregistered chat after agent error',
        );
        continue;
      }
    }
  }
}
