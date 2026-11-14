/**
 * 无状态 Telegram 双向中继 Bot（Cloudflare Workers）。
 *
 * 路由方式：通知正文第二行固定为 `chatId-messageId`。
 * 文本通知、媒体 caption、贴纸说明都通过这一行承载路由，
 * 主人回复该消息即可定位原会话，不需要保存消息映射。
 *
 * 媒体转发：
 * - 图片 / 视频 / 动图 / 文件 / 音频 / 语音：复用 file_id 直接转发，路由写在 caption 里。
 * - webp / tgs / webm 贴纸：贴纸没有 caption，先转发贴纸，再补一条文字通知承载路由。
 */

const TELEGRAM_API = "https://api.telegram.org";
const MAX_TEXT_LENGTH = 4096; // sendMessage 的 text 上限（UTF-16 码元）
const MAX_CAPTION_LENGTH = 1024; // 媒体 caption 上限（UTF-16 码元）
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

  await forwardToOwner(message, env, ownerId, chatId);
}

async function forwardToOwner(message, env, ownerId, chatId) {
  const media = mediaDescriptor(message);

  // 纯文本、位置、投票等服务消息：仍然是文字通知。
  if (!media) {
    await sendNotification(env, ownerId, message, chatId, null, describeContent(message));
    return;
  }

  if (media.kind === "sticker") {
    await forwardSticker(env, ownerId, message, chatId, media);
    return;
  }

  if (media.kind === "video_note") {
    // 视频留言没有 caption，单独转发后用文字通知承载路由。
    const sent = await safeSend(env, "sendVideoNote", {
      chat_id: ownerId,
      video_note: media.fileId,
    });
    await sendNotification(env, ownerId, message, chatId, sent?.message_id, "[video note]");
    return;
  }

  const caption = buildNotification(
    message,
    chatId,
    MAX_CAPTION_LENGTH,
    typeof message.caption === "string" ? message.caption.trim() : ""
  );

  try {
    await telegram(env, media.method, {
      chat_id: ownerId,
      [media.field]: media.fileId,
      caption,
    });
  } catch (error) {
    // 文件过大、类型不被接受等情况：至少让主人知道有人发了什么。
    console.error(`转发 ${media.method} 失败，回退为文字通知:`, error);
    await sendNotification(env, ownerId, message, chatId, null, fallbackContent(message));
  }
}

async function forwardSticker(env, ownerId, message, chatId, media) {
  // 贴纸没有 caption：先转发贴纸，再让文字通知作为它的回复，
  // 这样主人回复文字通知仍然可以路由回原用户。
  const sent = await safeSend(env, "sendSticker", {
    chat_id: ownerId,
    sticker: media.fileId,
  });
  await sendNotification(env, ownerId, message, chatId, sent?.message_id, describeContent(message));
}

async function sendNotification(env, ownerId, message, chatId, replyToMessageId, content) {
  const params = {
    chat_id: ownerId,
    text: buildNotification(message, chatId, MAX_TEXT_LENGTH, content),
    link_preview_options: { is_disabled: true },
  };

  if (replyToMessageId) {
    params.reply_parameters = {
      message_id: replyToMessageId,
      allow_sending_without_reply: true,
    };
  }

  await telegram(env, "sendMessage", params);
}

async function handleOwnerMessage(message, env) {
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const replied = message.reply_to_message;
  const route = parseRoute(replied?.text) ?? parseRoute(replied?.caption);

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
function buildNotification(message, chatId, limit, content) {
  const header = `${displayName(message.from)} 来消息了：`;
  const routeLine = `${chatId}-${message.message_id}`;
  const lines = [header, routeLine];

  if (content) {
    const budget = Math.max(limit - header.length - routeLine.length - 2, 0);
    lines.push(truncate(content, budget));
  }

  return lines.join("\n");
}

function mediaDescriptor(message) {
  if (message.sticker) {
    return {
      kind: "sticker",
      fileId: message.sticker.file_id,
    };
  }

  // 注意：动画消息同时带 document 字段，必须先判断 animation。
  if (message.animation) {
    return { kind: "file", method: "sendAnimation", field: "animation", fileId: message.animation.file_id };
  }
  if (message.video) {
    return { kind: "file", method: "sendVideo", field: "video", fileId: message.video.file_id };
  }
  if (message.video_note) {
    return { kind: "video_note", fileId: message.video_note.file_id };
  }
  if (message.voice) {
    return { kind: "file", method: "sendVoice", field: "voice", fileId: message.voice.file_id };
  }
  if (message.audio) {
    return { kind: "file", method: "sendAudio", field: "audio", fileId: message.audio.file_id };
  }
  if (message.document) {
    return { kind: "file", method: "sendDocument", field: "document", fileId: message.document.file_id };
  }
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return { kind: "file", method: "sendPhoto", field: "photo", fileId: largest.file_id };
  }

  return null;
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

  if (message.sticker) {
    return message.sticker.emoji ? `[sticker] ${message.sticker.emoji}` : "[sticker]";
  }

  return `[${mediaLabel(message)}]`;
}

function fallbackContent(message) {
  const label = `[${mediaLabel(message)}]`;
  const caption = typeof message.caption === "string" ? message.caption.trim() : "";
  return caption ? `${caption}\n${label}` : label;
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

async function safeSend(env, method, params) {
  try {
    return await telegram(env, method, params);
  } catch (error) {
    console.error(`Telegram ${method} 调用失败:`, error);
    return null;
  }
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
