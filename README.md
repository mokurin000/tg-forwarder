# Telegram Two-Way Relay Bot

A lightweight, stateless Telegram relay bot running on Cloudflare Workers.

Users can send messages to your bot, and the bot forwards them to you. Simply reply to a forwarded message to send your response back to the original sender.

Supports text, photos, videos, animations, documents, audio, voice messages, stickers, and more.

No database, no Durable Objects, and no message mapping table. Cloudflare KV is only used for configuration and the blocklist.

## Features

- **Stateless message routing** — The original `chat_id` and `message_id` are embedded in the forwarded message, so no message mapping needs to be stored.
- **Two-way relay** — Reply directly to a forwarded notification to message the original sender.
- **Media support** — Supports photos, videos, animations, documents, audio, voice messages, and stickers using Telegram's existing `file_id`.
- **Blocklist** — Block or unblock users by replying to their messages with `/spam` or `/unspam`.
- **Cloudflare KV storage** — Stores the owner ID and blocklist entries.
- **Secure configuration** — Bot credentials and webhook secrets are stored as Cloudflare Worker Secrets.
- **Webhook verification** — Validates Telegram's `X-Telegram-Bot-Api-Secret-Token` header. Requests are rejected if no webhook secret is configured.
- **No duplicate retries** — Telegram API errors are logged, but the Worker still returns HTTP 200 to prevent Telegram from retrying the same update.

## How It Works

The bot does not maintain a mapping between forwarded messages and their original messages.

Instead, every forwarded notification includes a routing identifier on its second line:

```text
John Doe (@johndoe) sent you a message:
123456789-42
Hello!
```

The second line contains:

```text
<chat_id>-<message_id>
```

When you reply to the notification, the bot extracts these values and sends your reply to the original chat.

For media messages, the same routing information is stored in the caption.

This approach keeps the bot completely stateless and eliminates the need for Durable Objects or a database.

## Media Support

The bot reuses Telegram `file_id` values to forward media in both directions. Files are never downloaded or uploaded again.

| Message type | Forwarding | Replying |
| --- | --- | --- |
| Photo | `sendPhoto` with the original `file_id` and caption | Reply to the photo |
| Video | `sendVideo` with the original `file_id` and caption | Reply to the video |
| Animation | Corresponding `send*` method with the original `file_id` | Reply to the animation |
| Document | `sendDocument` with the original `file_id` | Reply to the document |
| Audio | `sendAudio` with the original `file_id` | Reply to the audio |
| Voice message | `sendVoice` with the original `file_id` | Reply to the voice message |
| Sticker | `sendSticker`, followed by a text notification | Reply to the text notification |
| Video note | `sendVideoNote`, followed by a text notification | Reply to the text notification |
| Location, contact, poll, etc. | Text notification | Reply to the notification |

### Media Fallbacks

- If forwarding a media file fails (for example, due to file size or unsupported media types), the bot falls back to a text notification instead of silently dropping the message.
- Stickers do not support captions, so a separate text notification is sent after the sticker. Reply to that notification to respond.
- Video notes are handled in the same way as stickers.
- When replying with media, the bot sends it directly to the original user and attaches it as a reply to their original message.
- Captions are preserved when forwarding supported media.
- If sending reply media fails, the bot falls back to sending the caption as text. If no caption is available, it asks you to try another file.

## Project Structure

```text
.
├── src/
│   └── index.js           # Cloudflare Worker implementation
├── wrangler.toml          # Worker configuration
└── .dev.vars.example      # Local development environment variables
```

## Requirements

- Node.js >= 22.12 (required by Wrangler 4)
- A Cloudflare account (the free Workers plan is sufficient)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Deployment

### 1. Install Dependencies

```powershell
npm install
```

### 2. Create a KV Namespace

```powershell
npx wrangler kv namespace create BOT_KV
```

Copy the namespace ID from the output into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "BOT_KV"
id = "your-32-character-namespace-id"
```

### 3. Configure Worker Secrets

Set the bot token and webhook secret:

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

Generate a random webhook secret:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep this value somewhere safe. You will need the exact same value when configuring the Telegram webhook.

Neither secret should be committed to your repository.

### 4. Set the Owner ID

Store your Telegram user ID in KV:

```powershell
npx wrangler kv key put --binding=BOT_KV --remote owner_id 6150217362
```

You can change the owner at any time without redeploying the Worker:

```powershell
npx wrangler kv key put --binding=BOT_KV --remote owner_id NEW_TELEGRAM_USER_ID
```

### 5. Deploy the Worker

```powershell
npx wrangler deploy
```

Take note of the deployed Worker URL. It should look something like:

```text
https://telegram-relay-bot.<your-subdomain>.workers.dev
```

### 6. Configure the Telegram Webhook

In PowerShell, set the following variables:

```powershell
$TOKEN  = "123456:YOUR_BOT_TOKEN"
$SECRET = "YOUR_WEBHOOK_SECRET"
$WORKER = "https://telegram-relay-bot.<your-subdomain>.workers.dev"
```

Register the webhook:

```powershell
curl.exe -sS -X POST "https://api.telegram.org/bot$TOKEN/setWebhook" `
  -d "url=$WORKER/" `
  -d "secret_token=$SECRET"
```

Check the webhook status:

```powershell
curl.exe -sS "https://api.telegram.org/bot$TOKEN/getWebhookInfo"
```

A healthy configuration should have:

- `url` set to your Worker URL.
- `pending_update_count` equal to `0`.
- `last_error_message` empty.

**Note:** Use `curl.exe` instead of `curl` in Windows PowerShell, where `curl` is an alias for `Invoke-WebRequest`.

### 7. Start Using the Bot

Before receiving messages, open a private chat with your bot and send `/start` from the owner account.

Telegram bots cannot initiate private conversations with users who have never started them. Without this step, the bot will receive a `403: bot can't initiate conversation with a user` error when trying to send you notifications.

Once you have started the bot, send a message from another Telegram account. You should receive a notification and can reply directly to it.

## Commands

| Action | How to use |
| --- | --- |
| Reply to a user | Reply directly to a forwarded notification |
| Block a user | Reply to a notification with `/spam` |
| Unblock a user | Reply to a notification with `/unspam` |
| Show help | Send `/start` or `/help` in the bot's private chat |

The blocklist is keyed by `chat_id`:

- In private chats, `/spam` blocks that user.
- In group chats, `/spam` blocks the entire group.

KV replication is eventually consistent. Changes to the blocklist may take up to approximately 60 seconds to propagate globally.

### Managing the Blocklist Manually

List all blocklist entries:

```powershell
npx wrangler kv key list --binding=BOT_KV --remote
```

Remove a blocklist entry:

```powershell
npx wrangler kv key delete --binding=BOT_KV --remote "spam:123456789"
```

## Local Development

### 1. Configure Environment Variables

Copy the example file:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Edit `.dev.vars` and provide your `BOT_TOKEN` and `WEBHOOK_SECRET`.

### 2. Start the Development Server

```powershell
npx wrangler dev
```

Local KV and remote KV are separate namespaces. If you need an owner ID for local testing, set it explicitly:

```powershell
npx wrangler kv key put --binding=BOT_KV --local owner_id 6150217362
```

### 3. Test the Webhook Locally

You can simulate a Telegram webhook request without sending an actual Telegram message:

```powershell
$body = @'
{"update_id":1,"message":{"message_id":42,"date":0,"chat":{"id":123456789,"type":"private"},"from":{"id":123456789,"is_bot":false,"first_name":"Test","username":"tester"},"text":"Hello"}}
'@

curl.exe -sS -X POST "http://127.0.0.1:8787/" `
  -H "Content-Type: application/json" `
  -H "X-Telegram-Bot-Api-Secret-Token: YOUR_LOCAL_WEBHOOK_SECRET" `
  --data-binary $body
```

Make sure the secret matches the value in your local `.dev.vars` file.

## Security and Limitations

- **Credentials:** The bot token is stored in Worker Secrets and is never included in source code or log messages.
- **Message privacy:** Messages are forwarded as plaintext. Both Telegram and Cloudflare can access the message contents. Do not use this bot to exchange sensitive information.
- **No rate limiting:** Anyone who knows the bot's username can send messages to the owner. If needed, you can add an `allow:<chat_id>` whitelist or implement per-chat rate limiting using KV.
- **Message length:** Telegram text messages are limited to 4096 characters. Media captions are limited to 1024 characters. Longer content is truncated.
- **Media handling:** Media is forwarded using `file_id` without downloading or re-uploading. Files that exceed Telegram's limits or use unsupported types fall back to text notifications.
- **Stickers:** Stickers do not support captions or routing metadata. Reply to the accompanying text notification instead.
- **Owner identification:** Only messages sent by the configured owner account in a private chat are treated as owner commands.
- **Group behavior:** If the bot is added to a group, messages from that group are forwarded using the group's `chat_id`. Blocking the group blocks all messages from it.
- **Group limitations:** Owner commands sent in groups are not supported because the group's `chat.id` is different from the owner's user ID.

## Troubleshooting

### `401 Unauthorized`

The webhook secret header is missing or does not match the configured secret.

Check that the `secret_token` passed to `setWebhook` exactly matches the `WEBHOOK_SECRET` configured in Worker Secrets.

### Notifications Are Not Arriving

Check the following:

1. Make sure the owner account has sent `/start` to the bot.
2. Verify that `owner_id` exists in KV:

   ```powershell
   npx wrangler kv key get --binding=BOT_KV --remote owner_id
   ```

3. Check Worker logs using `wrangler tail` or the Cloudflare dashboard for Telegram API errors.

### Replies Are Not Delivered

The original user may have deleted the conversation or blocked the bot.

`allow_sending_without_reply` only handles cases where the original message has been deleted. It does not bypass Telegram's restrictions on sending messages to users who have blocked the bot.

### Replying to a Sticker Does Nothing

Stickers do not contain routing metadata. Reply to the text notification sent immediately after the sticker instead.

### Changes to `owner_id` Are Not Taking Effect

KV reads may be cached or temporarily inconsistent. Wait approximately 60 seconds and try again.

Also make sure the stored value does not contain leading or trailing whitespace.

---

## License

The MIT License.
