import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, MAIN_GROUP_FOLDER, TRIGGER_PATTERN } from '../config.js';
import { WhatsAppChannel } from '../channels/whatsapp.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from '../container-runtime.js';
import { deleteMessagesBySender, initDatabase, storeChatMetadata, storeMessage } from '../db.js';
import { GroupQueue } from '../group-queue.js';
import { startIpcWatcher } from '../ipc.js';
import { startSchedulerLoop } from '../task-scheduler.js';
import { Channel, NewMessage } from '../types.js';
import { logger } from '../logger.js';
import { findChannel, formatOutbound } from '../router.js';
import { ConversationService } from './conversation.js';
import { MessageIngestionService } from './message-ingestion.js';
import { writeGroupsSnapshot } from '../container-runner.js';

export class RuntimeCoordinator {
  private queue = new GroupQueue();
  private channels: Channel[] = [];
  private whatsapp!: WhatsAppChannel;
  private conversation: ConversationService;
  private ingestion: MessageIngestionService;

  constructor() {
    this.conversation = new ConversationService(
      this.queue,
      (jid: string) => findChannel(this.channels, jid),
      () => this.ingestion.allowedSendersState,
    );
    this.ingestion = new MessageIngestionService(
      this.conversation,
      this.queue,
      (jid: string) => findChannel(this.channels, jid),
    );

    this.queue.setProcessMessagesFn(this.conversation.processGroupMessages.bind(this.conversation));
  }

  private ensureContainerSystemRunning(): void {
    ensureContainerRuntimeRunning();
    cleanupOrphans();
  }

  private loadContactsFile(): void {
    const contactsPath = path.join(process.cwd(), 'contacts.txt');
    if (!fs.existsSync(contactsPath)) return;

    const lines = fs.readFileSync(contactsPath, 'utf-8').split('\n');
    let added = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const parts = trimmed.split('|').map((p) => p.trim());
      if (parts.length < 3) continue;

      const [phone, name, folder] = parts;
      if (!phone || !name || !folder) continue;

      const jid = `${phone}@s.whatsapp.net`;
      if (this.conversation.registeredGroups[jid]) continue;

      this.conversation.registerGroup(jid, {
        name,
        folder,
        trigger: `@${ASSISTANT_NAME}`,
        added_at: new Date().toISOString(),
        requiresTrigger: false,
      });
      added++;
    }

    if (added > 0) {
      logger.info({ added }, 'Loaded new contacts from contacts.txt');
    }
  }

  public async start(): Promise<void> {
    this.ensureContainerSystemRunning();
    initDatabase();
    logger.info('Database initialized');
    
    this.conversation.loadState();
    this.ingestion.loadState();
    this.loadContactsFile();

    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Shutdown signal received');
      await this.queue.shutdown(10000);
      for (const ch of this.channels) await ch.disconnect();
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    const channelOpts = {
      onMessage: (_chatJid: string, msg: NewMessage) => {
        storeMessage(msg);
        const group = this.conversation.registeredGroups[_chatJid];
        if (
          group &&
          group.folder === MAIN_GROUP_FOLDER &&
          !msg.is_bot_message &&
          this.ingestion.allowedSendersState.enabled &&
          !this.ingestion.allowedSendersState.senderSet.has(msg.sender)
        ) {
          deleteMessagesBySender(_chatJid, msg.sender);
          logger.info(
            { sender: msg.sender },
            'Deleted message from blocked sender',
          );
        }
        this.ingestion.wakeMessageLoop();
      },
      onAnyMessage: (_chatJid: string, msg: NewMessage) => {
        if (this.conversation.registeredGroups[_chatJid]) return;
        if (msg.is_bot_message) return;
        if (!TRIGGER_PATTERN.test(msg.content.trim())) return;

        if (
          this.ingestion.allowedSendersState.enabled &&
          this.ingestion.allowedSendersState.senderSet.has(msg.sender)
        ) {
          storeMessage(msg);
          this.ingestion.wakeMessageLoop();
        }
      },
      onChatMetadata: (
        chatJid: string,
        timestamp: string,
        name?: string,
        channel?: string,
        isGroup?: boolean,
      ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
      registeredGroups: () => this.conversation.registeredGroups,
    };

    this.whatsapp = new WhatsAppChannel(channelOpts);
    this.channels.push(this.whatsapp);
    await this.whatsapp.connect();

    startSchedulerLoop({
      registeredGroups: () => this.conversation.registeredGroups,
      getSessions: () => this.conversation.sessions,
      queue: this.queue,
      onProcess: (groupJid, proc, containerName, groupFolder) =>
        this.queue.registerProcess(groupJid, proc, containerName, groupFolder),
      sendMessage: async (jid, rawText) => {
        const channel = findChannel(this.channels, jid);
        if (!channel) {
          console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
          return;
        }
        const text = formatOutbound(rawText);
        if (text) await channel.sendMessage(jid, text);
      },
    });

    startIpcWatcher({
      sendMessage: (jid, text) => {
        const channel = findChannel(this.channels, jid);
        if (!channel) throw new Error(`No channel for JID: ${jid}`);
        return channel.sendMessage(jid, text);
      },
      registeredGroups: () => this.conversation.registeredGroups,
      registerGroup: (jid, group) => this.conversation.registerGroup(jid, group),
      syncGroupMetadata: (force) =>
        this.whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
      getAvailableGroups: () => this.conversation.getAvailableGroups(),
      writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    });

    this.ingestion.startAllowedSendersWatcher();
    this.ingestion.recoverPendingMessages();
    this.ingestion.startMessageLoop().catch((err) => {
      logger.fatal({ err }, 'Message loop crashed unexpectedly');
      process.exit(1);
    });
  }

  public getAvailableGroups() {
    return this.conversation.getAvailableGroups();
  }

  public _setRegisteredGroups(groups: Record<string, import('../types.js').RegisteredGroup>) {
    this.conversation._setRegisteredGroups(groups);
  }
}

