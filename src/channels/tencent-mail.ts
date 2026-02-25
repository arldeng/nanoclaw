import fs from 'fs';
import { ImapFlow } from 'imapflow';
import { simpleParser, ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';

import { ASSISTANT_NAME } from '../config.js';
import {
  getLastProcessedUid,
  isEmailProcessed,
  markEmailProcessed,
} from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

interface TencentMailConfig {
  email: string;
  password: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
}

export interface TencentMailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TencentMailChannel implements Channel {
  name = 'tencent-mail';

  private config: TencentMailConfig;
  private smtpTransport: nodemailer.Transporter | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private opts: TencentMailChannelOpts;
  private pollInterval: number;
  private connected = false;

  constructor(configPath: string, pollInterval: number, opts: TencentMailChannelOpts) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    this.config = JSON.parse(raw) as TencentMailConfig;
    this.opts = opts;
    this.pollInterval = pollInterval;
  }
  async connect(): Promise<void> {
    this.smtpTransport = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: { user: this.config.email, pass: this.config.password },
    });

    // Verify SMTP connection
    try {
      await this.smtpTransport.verify();
      logger.info('Tencent Mail SMTP verified');
    } catch (err) {
      logger.error({ err }, 'Tencent Mail SMTP verification failed');
    }

    // Initial poll, then start timer
    await this.pollInbox();
    this.pollTimer = setInterval(() => this.pollInbox(), this.pollInterval);

    this.connected = true;
    logger.info('Tencent Mail channel connected');
    console.log('\n  Tencent Mail channel connected');
    console.log(`  Monitoring: ${this.config.email}\n`);
  }

  private async pollInbox(): Promise<void> {
    let client: ImapFlow | null = null;
    try {
      client = new ImapFlow({
        host: this.config.imap.host,
        port: this.config.imap.port,
        secure: this.config.imap.secure,
        auth: { user: this.config.email, pass: this.config.password },
        logger: false,
      });

      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const lastUid = getLastProcessedUid('INBOX');
        // Fetch messages with UID greater than last processed
        const range = lastUid > 0 ? `${lastUid + 1}:*` : '1:*';

        for await (const msg of client.fetch(range, {
          uid: true,
          envelope: true,
          source: true,
        })) {
          if (msg.uid <= lastUid) continue;
          if (isEmailProcessed(msg.uid, 'INBOX')) continue;

          await this.processEmail(msg);
        }
      } finally {
        lock.release();
      }

      await client.logout();
    } catch (err) {
      logger.error({ err }, 'Tencent Mail poll error');
      try { await client?.logout(); } catch { /* ignore */ }
    }
  }
  private async processEmail(msg: { uid: number; envelope: any; source: Buffer }): Promise<void> {
    try {
      const parsed: ParsedMail = await simpleParser(msg.source);
      const from = msg.envelope?.from?.[0];
      const senderEmail = from?.address || 'unknown';
      const senderName = from?.name || senderEmail;
      const subject = parsed.subject || '(no subject)';
      const body = parsed.text || parsed.html?.replace(/<[^>]+>/g, '') || '';
      const messageId = parsed.messageId || `uid-${msg.uid}`;
      const date = parsed.date || new Date();

      // Skip emails from self
      if (senderEmail.toLowerCase() === this.config.email.toLowerCase()) {
        markEmailProcessed(msg.uid, senderEmail, messageId, 'INBOX');
        return;
      }

      const chatJid = `email:${senderEmail}`;
      const timestamp = date.toISOString();
      const content = `@${ASSISTANT_NAME} [邮件] 主题: ${subject}\n\n${body.slice(0, 8000)}`;

      // Store chat metadata
      this.opts.onChatMetadata(chatJid, timestamp, senderName, 'tencent-mail', false);

      // Only deliver for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid, senderEmail, subject }, 'Email from unregistered sender — JID logged for registration');
        markEmailProcessed(msg.uid, senderEmail, messageId, 'INBOX');
        return;
      }

      this.opts.onMessage(chatJid, {
        id: messageId,
        chat_jid: chatJid,
        sender: senderEmail,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      markEmailProcessed(msg.uid, senderEmail, messageId, 'INBOX');
      logger.info({ uid: msg.uid, from: senderEmail, subject }, 'Email processed');
    } catch (err) {
      logger.error({ uid: msg.uid, err }, 'Failed to process email');
    }
  }
  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.smtpTransport) {
      logger.warn('Tencent Mail SMTP not initialized');
      return;
    }

    try {
      const recipientEmail = jid.replace(/^email:/, '');
      await this.smtpTransport.sendMail({
        from: this.config.email,
        to: recipientEmail,
        subject: `Re: ${ASSISTANT_NAME}`,
        text,
      });
      logger.info({ jid, length: text.length }, 'Email sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send email');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('email:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.smtpTransport) {
      this.smtpTransport.close();
      this.smtpTransport = null;
    }
    this.connected = false;
    logger.info('Tencent Mail channel disconnected');
  }
}
