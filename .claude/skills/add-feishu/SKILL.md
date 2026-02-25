---
name: add-feishu
description: Add Feishu (Lark) as a channel. Can replace WhatsApp entirely or run alongside it.
---

# Add Feishu Channel

This skill adds Feishu (飞书/Lark) support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `feishu` is in `applied_skills`, skip to Phase 3 (Setup).

### Ask the user

1. **Mode**: Replace WhatsApp or add alongside it?
   - Replace → will set `FEISHU_ONLY=true`
   - Alongside → both channels active (default)

2. **Do they already have a Feishu app?** If yes, collect App ID and App Secret now. If no, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-feishu
```

This deterministically:
- Adds `src/channels/feishu.ts` (FeishuChannel class implementing Channel interface)
- Three-way merges Feishu support into `src/index.ts`
- Three-way merges Feishu config into `src/config.ts`
- Installs the `@larksuiteoapi/node-sdk` npm dependency
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md`
- `modify/src/config.ts.intent.md`

### Validate

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Create Feishu App (if needed)

If the user doesn't have an app, tell them:

> 1. Go to [Feishu Open Platform](https://open.feishu.cn/app) and click **创建企业自建应用** (Create Enterprise Self-Built App)
> 2. Fill in app name and description
> 3. Go to **凭证与基础信息** (Credentials & Basic Info) — copy the **App ID** and **App Secret**
> 4. Go to **事件与回调** (Events & Callbacks) → **加密策略** (Encryption Strategy):
>    - Set an **Encrypt Key** (optional but recommended)
>    - Set a **Verification Token**
> 5. Go to **事件与回调** → **事件配置** → subscribe to:
>    - `im.message.receive_v1` (receive messages)
> 6. Go to **权限管理** (Permission Management) and enable:
>    - `im:message` (read messages)
>    - `im:message:send_as_bot` (send messages)
>    - `im:chat` (read chat info)
> 7. Go to **机器人** (Bot) tab and enable the bot feature
> 8. **Publish** the app (or use test mode)

Wait for the user to provide App ID, App Secret, Verification Token, and Encrypt Key.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_VERIFICATION_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_ENCRYPT_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

If they chose to replace WhatsApp:

```bash
FEISHU_ONLY=true
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Enable WebSocket connection mode

NanoClaw uses the Feishu WebSocket (长连接) mode — no public webhook URL needed.

In the Feishu app console, go to **事件与回调** → **事件配置** and select **使用长连接接收事件** (Use long connection to receive events). This avoids needing a public HTTPS endpoint.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.plist
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> Send any message to your bot in Feishu (private chat or group). The bot will log the chat ID — check the logs:
>
> ```bash
> tail -f logs/nanoclaw.log | grep "unregistered Feishu"
> ```
>
> You'll see a line like:
> `Message from unregistered Feishu chat — chatJid logged above for registration`
> with `chatJid: "fs:oc_xxxxxxxxxxxxxxxx"` above it.

Wait for the user to provide the chat JID (format: `fs:oc_...` for groups, `fs:ou_...` for private chats).

### Register the chat

For a main chat (responds to all messages, uses the `main` folder):

```typescript
registerGroup("fs:oc_xxxxxxxxxxxxxxxx", {
  name: "<chat-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("fs:oc_xxxxxxxxxxxxxxxx", {
  name: "<chat-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Feishu chat:
> - For main chat: Any message works
> - For non-main: @mention the bot or use the trigger pattern
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Supported Message Types

The Feishu channel handles all Feishu message types:

| Type | Handling |
|------|---------|
| `text` | Full text delivered to agent |
| `post` (富文本) | Title + body text extracted |
| `image` | `[图片: <key>]` placeholder |
| `file` | `[文件: <filename>]` placeholder |
| `audio` | `[语音消息: Xs]` placeholder with duration |
| `video` | `[视频: <key>]` placeholder |
| `sticker` | `[表情包: <key>]` placeholder |
| `share_chat` | `[分享群: <chat_id>]` placeholder |
| `share_user` | `[分享用户: <user_id>]` placeholder |
| `location` | `[位置: name (lat, lon)]` placeholder |

@mentions of the bot are automatically translated to the trigger pattern so the agent responds correctly.

## Troubleshooting

### Bot not responding

1. Check env vars are set in `.env` AND synced to `data/env/env`
2. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'fs:%'"`
3. For non-main chats: message must include trigger pattern or @mention
4. Service is running: `launchctl list | grep nanoclaw`
5. Check Feishu app has `im.message.receive_v1` event subscription and bot permissions published

### Finding the chat JID

If the log grep doesn't show it, enable debug logging or temporarily lower the log level:

```bash
tail -f logs/nanoclaw.log | grep "fs:"
```

### WebSocket not connecting

Ensure the Feishu app is set to **长连接** (long connection) mode in the event configuration, not webhook mode. The bot does not expose an HTTP endpoint.

## After Setup

Ask the user:

> Would you like to configure any additional Feishu groups, or set up scheduled tasks that post to Feishu?
