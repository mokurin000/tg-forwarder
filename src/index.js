/**
 * 无状态 Telegram 双向中继 Bot（Cloudflare Workers）。
 *
 * 设计要点：
 * - 不保存「通知消息 -> 原消息」映射。通知正文第二行写入 `chatId-messageId`，
 *   主人回复该通知时，直接解析这一行完成路由。
 * - 主人 UID 与屏蔽列表放在 KV；Bot Token 与 Webhook Secret 放在 Worker Secrets。
 * - 所有网络请求都 await，失败只记录日志并返回 200，避免 Telegram 重投递造成重复转发。
 */

const TELEGRAM_API = "https://api.telegram.org";
const MAX_TEXT_LENGTH = 4096; // Telegram sendMessage 的 text 上限（UTF-16 码元）
const ROUTE_PATTERN = /^(-?\d+)-(\d+)$/;

const MESSAGE_TYPES = [
  "photo",
  "video",
  "animation",
  "document",
  "audio",
  "voice",
  "video_note",
  "sticker",
  "location",
  "contact",
  "poll",
  "dice",
  "venue",
  "new_chat_members",
  "left_chat_member",
  "pinned_message",
];

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return textResponse("OK");
    }

    // 用 Telegram 的 secret token 校验请求来源；未配置时一律拒绝（fail closed）。
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return textResponse("Unauthorized", 401);
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return textResponse("Bad Request", 400);
    }

    try {
      await handleUpdate(update, env);
    } catch (error) {
      // 返回 4xx/5xx 会让 Telegram 反复重投同一条 update，可能给用户重复发消息。
      console.error("处理 update 失败:", error);
    }

    return textResponse("OK");
  },
};

async function handleUpdate(update, env) {
  const message = update?.message;
  if (!message?.chat?.id || !message.from) {
    return;
  }

  const ownerId = String((await env.BOT_KV.get("owner_id")) ?? "").trim();
  if (!ownerId) {
    console.error("KV 中缺少 owner_id，请在部署后写入该键。");
    return;
  }

  // 主人的私聊：只处理「回复某条通知」的消息。
  if (String(message.chat.id) === ownerId) {
    await handleOwnerMessage(message, env);
    return;
  }

  // 忽略其它 Bot，避免两个 Bot 互相回环。
  if (message.from.is_bot) {
    return;
  }

  const chatId = String(message.chat.id);

  // 已被屏蔽的用户/群：静默丢弃，不给主人任何提示。
  if (await env.BOT_KV.get(`spam:${chatId}`)) {
    return;
  }

  await telegram(env, "sendMessage", {
    chat_id: ownerId,
    text: buildNotification(message, chatId),
    link_preview_options: { is_disabled: true },
  });
}

async function handleOwnerMessage(message, env) {
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const route = parseRoute(message.reply_to_message?.text);

  // 不是对通知的回复：只有命令才回应，避免主人随手发消息时被 Bot 打扰。
  if (!route) {
    if (text.startsWith("/")) {
      await sendUsage(env, message.chat.id, message.message_id);
    }
    return;
  }

  if (isCommand(text, "spam")) {
    await env.BOT_KV.put(`spam:${route.chatId}`, "1");
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: `已屏蔽用户 ${route.chatId}，之后其消息不再转发。`,
      reply_parameters: { message_id: message.message_id },
    });
    return;
  }

  if (isCommand(text, "unspam")) {
    await env.BOT_KV.delete(`spam:${route.chatId}`);
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: `已解除屏蔽 ${route.chatId}，之后会继续转发其消息。`,
      reply_parameters: { message_id: message.message_id },
    });
    return;
  }

  const content =
    typeof message.text === "string"
      ? message.text
      : typeof message.caption === "string"
        ? message.caption
        : "";

  if (!content.trim()) {
    // 主人只发了媒体、或只有空白字符：明确告知无法转发，而不是静默丢弃。
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "无法转发该回复：请用文字回复，或给图片/文件添加说明文字。",
      reply_parameters: { message_id: message.message_id },
    });
    return;
  }

  await telegram(env, "sendMessage", {
    chat_id: route.chatId,
    text: truncate(content, MAX_TEXT_LENGTH),
    reply_parameters: {
      message_id: route.messageId,
      allow_sending_without_reply: true,
    },
  });
}

/**
 * 通知格式（第二行固定为路由信息）：
 *
 *   张三 (@zhangsan) 来消息了：
 *   123456789-42
 *   你好
 */
function buildNotification(message, chatId) {
  const header = `${displayName(message.from)} 来消息了：`;
  const routeLine = `${chatId}-${message.message_id}`;
  const content = describeContent(message);

  // 预留两个换行符，剩余空间给正文，保证整条通知不超过 Telegram 上限。
  const budget = MAX_TEXT_LENGTH - header.length - routeLine.length - 2;
  return [header, routeLine, truncate(content, Math.max(budget, 0))].join("\n");
}

function displayName(from) {
  const name =
    [from.first_name, from.last_name]
      .filter((part) => typeof part === "string" && part.trim())
      .join(" ")
      .trim() || "Unknown";
  const username = from.username ? ` (@${from.username})` : "";

  // 名字理论上可能带换行，清掉以保证第二行一定是路由信息。
  return `${name}${username}`.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function describeContent(message) {
  if (typeof message.text === "string" && message.text) {
    return message.text;
  }

  const caption = typeof message.caption === "string" ? message.caption.trim() : "";
  const label = mediaLabel(message);

  return caption ? `${caption}\n[${label}]` : `[${label}]`;
}

function mediaLabel(message) {
  for (const type of MESSAGE_TYPES) {
    if (message[type]) {
      return type;
    }
  }
  return "不支持的消息类型";
}

function parseRoute(text) {
  if (typeof text !== "string") {
    return null;
  }

  const lines = text.split("\n");
  if (lines.length < 2) {
    return null;
  }

  const match = lines[1].trim().match(ROUTE_PATTERN);
  if (!match) {
    return null;
  }

  const chatId = match[1];
  const messageId = Number(match[2]);

  // message_id 必须为正整数，否则一定是伪造/损坏的路由行。
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return null;
  }

  return { chatId, messageId };
}

function isCommand(text, name) {
  return new RegExp(`^/${name}(?:@\\w+)?(?:\\s|$)`, "i").test(text);
}

async function sendUsage(env, chatId, messageId) {
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text: [
      "使用说明：",
      "1. 直接回复 Bot 转发来的通知，内容会发回原用户。",
      "2. 回复 /spam 屏蔽该用户，/unspam 解除屏蔽。",
    ].join("\n"),
    reply_parameters: { message_id: messageId },
  });
}

function truncate(text, max) {
  if (text.length <= max) {
    return text;
  }
  if (max <= 1) {
    return "…";
  }

  // 不要从 UTF-16 代理对中间截断，否则会留下孤立代理项，Telegram 可能直接拒收。
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }

  return `${text.slice(0, end)}…`;
}

async function telegram(env, method, params) {
  if (!env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN 未配置，请运行 `npx wrangler secret put BOT_TOKEN`。");
  }

  const response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    // 避免 Telegram 接口长时间无响应拖到 webhook 超时，引发重复投递。
    signal: AbortSignal.timeout(10_000),
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram ${method} 返回了非 JSON 响应（HTTP ${response.status}）`);
  }

  if (!result?.ok) {
    throw new Error(
      `Telegram ${method} 失败（${result?.error_code ?? response.status}）：${
        result?.description ?? "未知错误"
      }`
    );
  }

  return result.result;
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
