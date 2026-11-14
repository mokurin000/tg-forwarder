# Telegram 双向中继 Bot（Cloudflare Workers）

一个无状态、无数据库的 Telegram 私聊中继：陌生人给 Bot 发消息，Bot 转发给主人；主人直接回复那条通知，内容就发回原用户。支持文字、图片、视频、文件、语音和贴纸，屏蔽列表和主人 UID 都存在 Workers KV 里。

## 设计

- **无状态路由**：不保存「通知消息 → 原消息」的映射。通知正文第二行固定写入 `chatId-messageId`，主人回复通知时解析这一行即可定位原会话，因此不需要 Durable Objects。
- **配置与凭证分离**：`owner_id` 与 `spam:<chat_id>` 放 KV；`BOT_TOKEN`、`WEBHOOK_SECRET` 只放 Worker Secrets，不写进代码或仓库。
- **请求来源校验**：校验 `X-Telegram-Bot-Api-Secret-Token`，未配置 secret 时直接拒绝（fail closed）。
- **失败不重投**：Telegram API 出错只记录日志并返回 `200`，避免 Telegram 重投 update 导致同一消息被转发两次。
- **媒体复用 file_id**：图片、视频、动图、文件、音频、语音直接按 `file_id` 转发，不下载、不重新上传；路由写在媒体 caption 的第二行。

通知格式：

```text
张三 (@zhangsan) 来消息了：
123456789-42
你好
```

第二行 `123456789-42` = `chat_id` + `-` + `message_id`。

媒体消息会把同样的三行写进 caption：

```text
张三 (@zhangsan) 来消息了：
123456789-42
看图
```

## 媒体转发

| 消息类型 | 转发方式 | 回复方式 |
| --- | --- | --- |
| 图片 | `sendPhoto`，复用 `file_id` + caption | 回复图片 |
| 视频 | `sendVideo`，复用 `file_id` + caption | 回复视频 |
| 动图 / 文件 / 音频 / 语音 | 对应的 `send*` 方法，复用 `file_id` + caption | 回复该消息 |
| 贴纸（webp / tgs / webm） | `sendSticker` 后补一条文字通知 | 回复贴纸下面的文字通知 |
| 视频留言 | `sendVideoNote` 后补一条文字通知 | 回复文字通知 |
| 位置 / 联系人 / 投票等 | 文字通知 | 回复通知 |

媒体不会下载或重新上传：同一个 Bot 内可以直接复用 `file_id`。文件中转失败（过大、类型不被接受）时会退化为文字通知，不会静默丢失。

## 目录结构

```text
src/index.js           Worker 全部逻辑
wrangler.toml          Worker 配置（需填入 KV namespace id）
.dev.vars.example      本地开发用的环境变量示例
```

## 前置条件

- Node.js ≥ 22.12（wrangler 4 的要求）
- 一个 Cloudflare 账号（Workers 免费套餐即可）
- 从 [@BotFather](https://t.me/BotFather) 拿到的 Bot Token

## 部署步骤

### 1. 安装依赖

```powershell
npm install
```

### 2. 创建 KV namespace

```powershell
npx wrangler kv namespace create BOT_KV
```

把输出里的 `id` 填进 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "BOT_KV"
id = "输出里的 32 位 id"
```

### 3. 写入 Secrets

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

`WEBHOOK_SECRET` 用随机高强度字符串，例如：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

> 这个值同时要传给 Telegram 的 `setWebhook`，两处必须完全一致。

### 4. 写入主人 UID

```powershell
npx wrangler kv key put --binding=BOT_KV --remote owner_id 6150217362
```

之后换主人只需要改这个键，**不用重新部署**：

```powershell
npx wrangler kv key put --binding=BOT_KV --remote owner_id 新的UID
```

### 5. 部署

```powershell
npx wrangler deploy
```

记下输出里的地址，形如 `https://telegram-relay-bot.<你的子域>.workers.dev`。

### 6. 设置 Webhook

```powershell
$TOKEN  = "123456:你的BotToken"
$SECRET = "与 WEBHOOK_SECRET 完全一致的值"
$WORKER = "https://telegram-relay-bot.<你的子域>.workers.dev"

curl.exe -sS -X POST "https://api.telegram.org/bot$TOKEN/setWebhook" `
  -d "url=$WORKER/" `
  -d "secret_token=$SECRET"
```

> Windows PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，必须写 `curl.exe`。

检查状态：

```powershell
curl.exe -sS "https://api.telegram.org/bot$TOKEN/getWebhookInfo"
```

正常时 `url` 是上面的地址，`pending_update_count` 为 0，`last_error_message` 为空。

### 7. 开始使用

**先让主人账号给 Bot 发一条 `/start`。** Telegram 不允许 Bot 主动给从未启动过它的用户发消息，否则会报 `403: bot can't initiate conversation with a user`。

然后用另一个账号给 Bot 发消息，主人应收到通知；主人直接回复通知即可回信。

## 命令

| 操作 | 方式 |
| --- | --- |
| 回复用户 | 直接回复 Bot 发来的通知 |
| 屏蔽用户 | 回复通知并发送 `/spam` |
| 解除屏蔽 | 回复通知并发送 `/unspam` |
| 查看命令说明 | 在 Bot 私聊里发送 `/start` 或 `/help` |

`/spam` 以 `chat_id` 为单位：私聊时等于屏蔽该用户，群聊时等于屏蔽整个群。屏蔽写入后全球生效可能有最多约 60 秒的 KV 最终一致性延迟。

也可以直接操作 KV：

```powershell
# 查看所有屏蔽键
npx wrangler kv key list --binding=BOT_KV --remote

# 手动解除屏蔽
npx wrangler kv key delete --binding=BOT_KV --remote "spam:123456789"
```

## 本地开发

```powershell
Copy-Item .dev.vars.example .dev.vars
# 编辑 .dev.vars，填入 BOT_TOKEN 与 WEBHOOK_SECRET
npx wrangler dev
```

本地 KV 与线上 KV 是两套存储，需要单独写入：

```powershell
npx wrangler kv key put --binding=BOT_KV --local owner_id 6150217362
```

不经过 Telegram、直接模拟一次 webhook 请求：

```powershell
$body = @'
{"update_id":1,"message":{"message_id":42,"date":0,"chat":{"id":123456789,"type":"private"},"from":{"id":123456789,"is_bot":false,"first_name":"测试","username":"tester"},"text":"你好"}}
'@

curl.exe -sS -X POST "http://127.0.0.1:8787/" `
  -H "Content-Type: application/json" `
  -H "X-Telegram-Bot-Api-Secret-Token: 与 .dev.vars 中的 WEBHOOK_SECRET 一致" `
  --data-binary $body
```

## 安全与限制

- Bot Token 只存在 Secret 中，日志与错误信息不会带出 token。
- 转发内容是明文；Telegram 与 Cloudflare 都能看到，不适合传敏感信息。
- 没有白名单和限速：任何人只要知道 Bot 用户名都能给主人发消息。需要的话可以在 KV 里加 `allow:<chat_id>` 或按 chat 做冷却。
- 单条消息上限 4096 字符，媒体 caption 上限 1024 字符，超出部分会被截断（通知与回信都会）。
- 媒体按 `file_id` 转发，不落地、不重新上传；文件过大或类型不被接受时会退化为文字通知。
- 贴纸本身没有 caption，不能直接回复贴纸，请回复紧随其后的文字通知。
- 主人回信只支持文字或带说明文字的媒体，不会把主人发的图片本体转发给用户。
- 只有 `owner_id` 对应私聊里的消息会被当作主人指令；Bot 被拉进群时，群消息会以整个群为单位转发和屏蔽。
- 群聊里主人的发言不会触发指令（因为 `chat.id` 是群 id 而不是主人 UID）。

## 常见问题

**401 Unauthorized**：请求头 `X-Telegram-Bot-Api-Secret-Token` 缺失或不匹配。检查 `setWebhook` 时传的 `secret_token` 与 Worker 里的 `WEBHOOK_SECRET` 是否一致。

**收不到通知**：确认主人已给 Bot 发过 `/start`；确认 KV 里有 `owner_id`（`npx wrangler kv key get --binding=BOT_KV --remote owner_id`）；用 `wrangler tail` 或面板日志看是否有 Telegram API 报错。

**回信没发出去**：原用户可能已经删除会话或屏蔽了 Bot；`allow_sending_without_reply` 只解决原消息被删除的情况，解决不了对方拒收。

**回复贴纸没反应**：贴纸没有 caption，本身不带路由。回复贴纸下方那条「来消息了」文字通知即可。

**改了 owner_id 不生效**：KV 读取有缓存，等约 60 秒；同时确认值里没有多余空格。
