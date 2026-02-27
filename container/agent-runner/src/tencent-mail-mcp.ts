/**
 * Tencent Mail MCP Server
 * Provides email tools (search, send, get) to agents inside containers.
 * Reads credentials from /home/node/.tencent-mail/config.json (mounted read-only).
 */

import fs from 'fs';
import path from 'path';
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

function isRetryable(err: any): boolean {
  if (err.message === 'IMAP_TIMEOUT' || err.code === 'ECONNRESET') return true;
  const msg = String(err.message || '').toLowerCase();
  if (msg.includes('connection closed') || msg.includes('connection lost') || msg.includes('socket closed') || msg.includes('econnrefused')) return true;
  return false;
}

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>, retries = 3, timeoutMs = 30000): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const client = new ImapFlow({
      host: config.imap.host,
      port: config.imap.port,
      secure: config.imap.secure,
      auth: { user: config.email, pass: config.password },
      logger: false,
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        (async () => {
          await client.connect();
          return await fn(client);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('IMAP_TIMEOUT')), timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      return result;
    } catch (err: any) {
      if (timer) clearTimeout(timer);
      client.close();
      await client.logout().catch(() => {});
      if (attempt < retries && isRetryable(err)) {
        await new Promise(r => setTimeout(r, 3000 * attempt));
        continue;
      }
      throw err;
    } finally {
      await client.logout().catch(() => {});
    }
  }
  throw new Error('withImap: unreachable');
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

          const result = await client.search(searchCriteria, { uid: true });
          // Take the last N UIDs (most recent)
          const allUids = Array.isArray(result) ? result : [];
          const recentUids = allUids.slice(-args.limit);
          if (recentUids.length === 0) return '没有找到邮件。';

          const range = recentUids.join(',');
          const emails: string[] = [];

          for await (const msg of client.fetch(range, {
            uid: true,
            envelope: true,
          }, { uid: true })) {
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
          }, { uid: true })) {
            found = true;
            const parsed = await simpleParser(msg.source as any) as any;
            const from = msg.envelope?.from?.[0];
            const sender = from?.name ? `${from.name} <${from.address}>` : from?.address || 'unknown';
            const to = msg.envelope?.to?.map((t: any) => t.address).join(', ') || '';
            const subject = parsed.subject || '(no subject)';
            const date = parsed.date?.toISOString() || '';
            const body = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, '') : '') || '(empty)';
            const messageId = parsed.messageId || '';

            const parts = [
              `From: ${sender}`,
              `To: ${to}`,
              parsed.cc ? `CC: ${(Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]).map((c: any) => c.text || c.address || String(c)).join(', ')}` : null,
              `Date: ${date}`,
              `Subject: ${subject}`,
              `Message-ID: ${messageId}`,
              `---`,
              body.slice(0, 10000),
            ].filter(Boolean);

            if (parsed.attachments && parsed.attachments.length > 0) {
              const attList = parsed.attachments.map((a: any) =>
                `${a.filename || 'unnamed'} (${a.size || 0} bytes)`
              ).join(', ');
              parts.push(`---`);
              parts.push(`Attachments: ${attList}`);
            }

            output = parts.join('\n');
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
    cc: z.string().optional().describe('CC recipients (comma-separated email addresses)'),
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

      if (args.cc) {
        mailOptions.cc = args.cc;
      }

      if (args.in_reply_to) {
        mailOptions.inReplyTo = args.in_reply_to;
        mailOptions.references = args.in_reply_to;
      }

      await transport.sendMail(mailOptions);
      transport.close();

      return { content: [{ type: 'text' as const, text: `邮件已发送至 ${args.to}${args.cc ? ` (CC: ${args.cc})` : ''}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `发送邮件失败: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'download_attachment',
  'Download an attachment from an email by UID and filename. Saves to the specified path.',
  {
    uid: z.number().describe('The UID of the email containing the attachment'),
    filename: z.string().describe('The attachment filename to download'),
    save_path: z.string().default('/workspace/group/').describe('Directory to save the file (default: /workspace/group/)'),
  },
  async (args) => {
    try {
      const result = await withImap<{ error: string } | { path: string; size: number }>(async (client) => {
        const lock = await client.getMailboxLock('INBOX');
        try {
          // Step 1: fetch bodyStructure to find the attachment MIME part
          let bodyStructure: any = null;
          for await (const msg of client.fetch(String(args.uid), {
            uid: true,
            bodyStructure: true,
          }, { uid: true })) {
            bodyStructure = msg.bodyStructure;
          }
          if (!bodyStructure) {
            return { error: `未找到 UID ${args.uid} 的邮件。` };
          }

          // Recursively find attachment parts
          function findParts(node: any, parts: any[] = []): any[] {
            if (node.disposition === 'attachment' || (node.filename && node.type !== 'multipart')) {
              parts.push(node);
            }
            if (node.childNodes) {
              for (const child of node.childNodes) findParts(child, parts);
            }
            return parts;
          }
          const attachmentParts = findParts(bodyStructure);
          if (attachmentParts.length === 0) {
            return { error: `邮件 UID ${args.uid} 没有附件。` };
          }

          const target = attachmentParts.find((p: any) => {
            const name = p.filename || p.dispositionParameters?.filename || p.parameters?.name || '';
            return name === args.filename;
          });
          if (!target) {
            const available = attachmentParts.map((p: any) =>
              p.filename || p.dispositionParameters?.filename || p.parameters?.name || 'unnamed'
            ).join(', ');
            return { error: `未找到附件 "${args.filename}"。可用附件: ${available}` };
          }

          // Step 2: download only the target part
          const { content } = await client.download(String(args.uid), target.part, { uid: true });
          const chunks: Buffer[] = [];
          for await (const chunk of content) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const data = Buffer.concat(chunks);

          const savePath = args.save_path.endsWith('/')
            ? path.join(args.save_path, args.filename)
            : args.save_path;
          const resolved = path.resolve(savePath);
          if (!resolved.startsWith('/workspace/')) {
            return { error: `路径不合法，必须在 /workspace/ 下: ${resolved}` };
          }
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          fs.writeFileSync(resolved, data);
          return { path: resolved, size: data.length };
        } finally {
          lock.release();
        }
      }, 3, 60000);

      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: result.error }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `附件已保存: ${result.path} (${result.size} bytes)` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `下载附件失败: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
