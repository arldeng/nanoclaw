/**
 * Tencent Mail MCP Server
 * Provides email tools (search, send, get) to agents inside containers.
 * Reads credentials from /home/node/.tencent-mail/config.json (mounted read-only).
 */

import fs from 'fs';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const CONFIG_PATH = '/home/node/.tencent-mail/config.json';

interface MailConfig {
  email: string;
  password: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
}

const config: MailConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

const server = new McpServer({
  name: 'tencentmail',
  version: '1.0.0',
});

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.email, pass: config.password },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

server.tool(
  'search_emails',
  'Search the inbox for recent emails. Returns a summary list with UID, sender, subject, and date.',
  {
    limit: z.number().default(20).describe('Max number of emails to return (default 20)'),
    since: z.string().optional().describe('Only emails after this date (ISO 8601, e.g. "2026-02-20")'),
  },
  async (args) => {
    try {
      const results = await withImap(async (client) => {
        const lock = await client.getMailboxLock('INBOX');
        try {
          const searchCriteria: any = {};
          if (args.since) searchCriteria.since = new Date(args.since);

          const uids = await client.search(searchCriteria, { uid: true });
          // Take the last N UIDs (most recent)
          const recentUids = uids.slice(-args.limit);
          if (recentUids.length === 0) return '没有找到邮件。';

          const range = recentUids.join(',');
          const emails: string[] = [];

          for await (const msg of client.fetch(range, {
            uid: true,
            envelope: true,
          })) {
            const from = msg.envelope?.from?.[0];
            const sender = from?.name ? `${from.name} <${from.address}>` : from?.address || 'unknown';
            const subject = msg.envelope?.subject || '(no subject)';
            const date = msg.envelope?.date?.toISOString() || '';
            emails.push(`UID:${msg.uid} | ${date.slice(0, 10)} | ${sender} | ${subject}`);
          }

          return emails.reverse().join('\n') || '没有找到邮件。';
        } finally {
          lock.release();
        }
      });

      return { content: [{ type: 'text' as const, text: results }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `搜索邮件失败: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);
server.tool(
  'get_email',
  'Get the full content of a specific email by its UID.',
  {
    uid: z.number().describe('The UID of the email to retrieve'),
  },
  async (args) => {
    try {
      const result = await withImap(async (client) => {
        const lock = await client.getMailboxLock('INBOX');
        try {
          let found = false;
          let output = '';

          for await (const msg of client.fetch(String(args.uid), {
            uid: true,
            envelope: true,
            source: true,
          })) {
            found = true;
            const parsed = await simpleParser(msg.source);
            const from = msg.envelope?.from?.[0];
            const sender = from?.name ? `${from.name} <${from.address}>` : from?.address || 'unknown';
            const to = msg.envelope?.to?.map((t: any) => t.address).join(', ') || '';
            const subject = parsed.subject || '(no subject)';
            const date = parsed.date?.toISOString() || '';
            const body = parsed.text || parsed.html?.replace(/<[^>]+>/g, '') || '(empty)';
            const messageId = parsed.messageId || '';

            output = [
              `From: ${sender}`,
              `To: ${to}`,
              `Date: ${date}`,
              `Subject: ${subject}`,
              `Message-ID: ${messageId}`,
              `---`,
              body.slice(0, 10000),
            ].join('\n');
          }

          return found ? output : `未找到 UID ${args.uid} 的邮件。`;
        } finally {
          lock.release();
        }
      });

      return { content: [{ type: 'text' as const, text: result }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `获取邮件失败: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);
server.tool(
  'send_email',
  'Send an email. Supports replying to a thread by providing in_reply_to Message-ID.',
  {
    to: z.string().describe('Recipient email address'),
    subject: z.string().describe('Email subject'),
    body: z.string().describe('Email body (plain text)'),
    in_reply_to: z.string().optional().describe('Message-ID to reply to (for threading)'),
  },
  async (args) => {
    try {
      const transport = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.secure,
        auth: { user: config.email, pass: config.password },
      });

      const mailOptions: nodemailer.SendMailOptions = {
        from: config.email,
        to: args.to,
        subject: args.subject,
        text: args.body,
      };

      if (args.in_reply_to) {
        mailOptions.inReplyTo = args.in_reply_to;
        mailOptions.references = args.in_reply_to;
      }

      await transport.sendMail(mailOptions);
      transport.close();

      return { content: [{ type: 'text' as const, text: `邮件已发送至 ${args.to}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `发送邮件失败: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
