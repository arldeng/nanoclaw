import fs from 'fs';
import path from 'path';

import * as Lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface FeishuChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// Feishu message content types
interface FeishuTextContent {
  text: string;
}
interface FeishuImageContent {
  image_key: string;
}
interface FeishuFileContent {
  file_key: string;
  file_name: string;
}
interface FeishuAudioContent {
  file_key: string;
  duration: number;
}
interface FeishuVideoContent {
  file_key: string;
  image_key: string;
}
interface FeishuStickerContent {
  file_key: string;
}
interface FeishuPostContent {
  title?: string;
  content: unknown[][];
}
interface FeishuShareChatContent {
  chat_id: string;
}
interface FeishuShareUserContent {
  user_id: string;
}
interface FeishuLocationContent {
  name: string;
  longitude: string;
  latitude: string;
}

function parseContent(msgType: string, content: string): string {
  try {
    const parsed = JSON.parse(content);
    switch (msgType) {
      case 'text': {
        const c = parsed as FeishuTextContent;
        return c.text || '';
      }
      case 'image': {
        const c = parsed as FeishuImageContent;
        return `[图片: ${c.image_key}]`;
      }
      case 'file': {
        const c = parsed as FeishuFileContent;
        return `[文件: ${c.file_name || c.file_key}]`;
      }
      case 'audio': {
        const c = parsed as FeishuAudioContent;
        return `[语音消息: ${Math.round(c.duration / 1000)}秒]`;
      }
      case 'video': {
        const c = parsed as FeishuVideoContent;
        return `[视频: ${c.file_key}]`;
      }
      case 'sticker': {
        const c = parsed as FeishuStickerContent;
        return `[表情包: ${c.file_key}]`;
      }
      case 'post': {
        const c = parsed as FeishuPostContent;
        const title = c.title ? `${c.title}\n` : '';
        const body = (c.content || [])
          .map((line: unknown[]) =>
            line
              .map((el: unknown) => {
                const e = el as Record<string, string>;
                if (e.tag === 'text') return e.text || '';
                if (e.tag === 'a') return `${e.text || ''}(${e.href || ''})`;
                if (e.tag === 'at') return `@${e.user_name || e.user_id || ''}`;
                if (e.tag === 'img') return '[图片]';
                return '';
              })
              .join(''),
          )
          .join('\n');
        return title + body;
      }
      case 'share_chat': {
        const c = parsed as FeishuShareChatContent;
        return `[分享群: ${c.chat_id}]`;
      }
      case 'share_user': {
        const c = parsed as FeishuShareUserContent;
        return `[分享用户: ${c.user_id}]`;
      }
      case 'location': {
        const c = parsed as FeishuLocationContent;
        return `[位置: ${c.name} (${c.latitude}, ${c.longitude})]`;
      }
      default:
        return `[${msgType}消息]`;
    }
  } catch {
    return `[${msgType}消息]`;
  }
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: Lark.Client | null = null;
  private wsClient: Lark.WSClient | null = null;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;
  private encryptKey: string;
  private verificationToken: string;
  private botOpenId: string = '';

  constructor(
    appId: string,
    appSecret: string,
    verificationToken: string,
    encryptKey: string,
    opts: FeishuChannelOpts,
  ) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.verificationToken = verificationToken;
    this.encryptKey = encryptKey;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: Lark.AppType.SelfBuild,
    });

    const eventDispatcher = new Lark.EventDispatcher({
      encryptKey: this.encryptKey,
      verificationToken: this.verificationToken,
    }).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data);
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    // Fetch bot's own open_id to detect self-messages
    try {
      const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      });
      const tokenData = await tokenRes.json() as any;
      if (tokenData.code === 0) {
        const botRes = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
          headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
        });
        const botData = await botRes.json() as any;
        this.botOpenId = botData?.bot?.open_id || '';
        logger.info({ botOpenId: this.botOpenId }, 'Feishu bot info fetched');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to fetch Feishu bot info');
    }

    return new Promise<void>((resolve) => {
      this.wsClient!.start({ eventDispatcher });
      // WSClient connects asynchronously; resolve after a short delay
      setTimeout(() => {
        logger.info('Feishu bot connected via WebSocket');
        console.log('\n  Feishu bot connected');
        console.log('  Send a message to get the chat ID for registration\n');
        resolve();
      }, 1000);
    });
  }

  private async handleMessage(data: any): Promise<void> {
    const msg = data.message;
    const sender = data.sender;
    if (!msg || !sender) return;

    // Skip messages sent by the bot itself
    if (sender.sender_id?.open_id === this.botOpenId) return;
    // Skip non-user senders
    if (sender.sender_type !== 'user') return;

    const chatId = msg.chat_id as string;
    const chatType = msg.chat_type as string; // 'p2p' | 'group'
    const chatJid = `fs:${chatId}`;
    const timestamp = new Date(parseInt(msg.create_time)).toISOString();
    const msgId = msg.message_id as string;
    const msgType = msg.message_type as string;

    const senderOpenId = sender.sender_id?.open_id || '';
    const senderName = (data.sender as any)?.sender_id?.open_id || senderOpenId;

    // Parse content based on message type
    let content = parseContent(msgType, msg.content || '{}');

    // Translate @bot mentions into TRIGGER_PATTERN format
    if (msgType === 'text' && !TRIGGER_PATTERN.test(content)) {
      // Feishu @mentions appear as <at user_id="...">name</at> in raw text
      // or as mention entities. Check if bot was @mentioned.
      const mentions: any[] = msg.mentions || [];
      const botMentioned = mentions.some(
        (m: any) => m.id?.open_id === this.botOpenId,
      );
      if (botMentioned) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Store chat metadata
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      chatId,
      'feishu',
      chatType === 'group',
    );

    // Only deliver for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatType },
        'Message from unregistered Feishu chat — chatJid logged above for registration',
      );
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: senderOpenId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: senderName }, 'Feishu message stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      return;
    }

    try {
      const chatId = jid.replace(/^fs:/, '');
      // Feishu text messages have a 30,000 char limit; split conservatively at 4000
      const MAX_LENGTH = 4000;
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        chunks.push(text.slice(i, i + MAX_LENGTH));
      }
      for (const chunk of chunks) {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
          },
        });
      }
      logger.info({ jid, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('fs:');
  }

  async disconnect(): Promise<void> {
    this.wsClient = null;
    this.client = null;
    logger.info('Feishu bot stopped');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu does not support typing indicators via Bot API
  }

  async sendImage(jid: string, imagePath: string, caption?: string): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      return;
    }
    try {
      const chatId = jid.replace(/^fs:/, '');
      // Upload image to get image_key
      const uploadRes = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(imagePath),
        },
      });
      const imageKey = (uploadRes as any)?.image_key || (uploadRes as any)?.data?.image_key;
      if (!imageKey) throw new Error('No image_key returned from upload');

      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });

      if (caption) {
        await this.sendMessage(jid, caption);
      }

      logger.info({ jid, imagePath }, 'Feishu image sent');
    } catch (err) {
      logger.error({ jid, imagePath, err }, 'Failed to send Feishu image');
    }
  }

  async sendFile(jid: string, filePath: string, caption?: string): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      return;
    }
    try {
      const chatId = jid.replace(/^fs:/, '');
      const fileName = path.basename(filePath);

      // Upload file to get file_key
      const uploadRes = await this.client.im.file.create({
        data: {
          file_type: 'stream',
          file_name: fileName,
          file: fs.createReadStream(filePath),
        },
      });
      const fileKey = (uploadRes as any)?.file_key || (uploadRes as any)?.data?.file_key;
      if (!fileKey) throw new Error('No file_key returned from upload');

      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });

      if (caption) {
        await this.sendMessage(jid, caption);
      }

      logger.info({ jid, filePath }, 'Feishu file sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Feishu file');
    }
  }
}
