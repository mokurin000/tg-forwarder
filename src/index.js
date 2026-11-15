
/**
 * Stateless Telegram two-way relay bot (Cloudflare Workers).
 *
 * Routing: The second line of every notification is `chatId-messageId`.
 * Text notifications, media captions, and sticker descriptions all carry
 * this routing information, allowing the owner to reply without storing
 * any message mappings.
 *
 * Media forwarding:
 * - Photos / videos / animations / documents / audio / voice messages:
 *   Forward directly using the original file_id, with routing information
 *   embedded in the caption.
 * - WebP / TGS / WebM stickers: Stickers do not support captions, so the
 *   bot forwards the sticker first and then sends a separate text notification.
 * - The owner can also reply with these media types, which are forwarded
 *   using their original file_id.
 */

const TELEGRAM_API = "https://api.telegram.org";
const MAX_TEXT_LENGTH = 4096; // sendMessage text limit (UTF-16 code units)
const MAX_CAPTION_LENGTH = 1024; // Media caption limit (UTF-16 code units)
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

    // Verify the request using Telegram's secret token.
    // Reject all requests if the secret is not configured (fail closed).
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
      // Returning a 4xx/5xx response would cause Telegram to retry the update,
      // potentially delivering the same message multiple times.
      console.error("Failed to process update:", error);
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
    console.error("Missing owner_id in KV. Set this key after deployment.");
    return;
  }

  // Handle private messages from the owner.
  // Only replies to forwarded notifications are processed.
  if (String(message.chat.id) === ownerId) {
    await handleOwnerMessage(message, env);
    return;
  }

  // Ignore messages from other bots to prevent bot-to-bot loops.
  if (message.from.is_bot) {
    return;
  }

  const chatId = String(message.chat.id);

  // Silently drop messages from blocked users or groups.
  if (await env.BOT_KV.get(`spam:${chatId}`)) {
    return;
  }

  await forwardToOwner(message, env, ownerId, chatId);
}

async function forwardToOwner(message, env, ownerId, chatId) {
  const media = mediaDescriptor(message);

  // Text, locations, polls, and other service messages are sent as text notifications.
  if (!media) {
    await sendNotification(env, ownerId, message, chatId, null, describeContent(message));
    return;
  }

  if (media.kind === "sticker") {
    await forwardSticker(env, ownerId, message, chatId, media);
    return;
  }

  if (media.kind === "video_note") {
    // Video notes do not support captions, so send a separate text notification
    // containing the routing information.
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
    // Fall back to a text notification if the media cannot be forwarded,
    // for example, because it is too large or unsupported.
    console.error(`Failed to forward ${media.method}, falling back to text:`, error);
    await sendNotification(env, ownerId, message, chatId, null, fallbackContent(message));
  }
}

async function forwardSticker(env, ownerId, message, chatId, media) {
  // Stickers do not support captions. Forward the sticker first, then send
  // a text notification as a reply so the owner can reply to it.
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

  // Ignore messages that are not replies to notifications.
  // Only respond to commands to avoid interrupting the owner unnecessarily.
  if (!route) {
    if (text.startsWith("/")) {
      await sendUsage(env, message.chat.id, message.message_id);
    }
    return;
  }

  // Commands are only recognized in plain text messages.
  // This prevents media captions from accidentally triggering commands.
  if (typeof message.text === "string") {
    if (isCommand(text, "spam")) {
      await env.BOT_KV.put(`spam:${route.chatId}`, "1");
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: `Blocked user ${route.chatId}. Their messages will no longer be forwarded.`,
        reply_parameters: { message_id: message.message_id },
      });
      return;
    }

    if (isCommand(text, "unspam")) {
      await env.BOT_KV.delete(`spam:${route.chatId}`);
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: `Unblocked ${route.chatId}. Their messages will be forwarded again.`,
        reply_parameters: { message_id: message.message_id },
      });
      return;
    }
  }

  const replyParameters = {
    message_id: route.messageId,
    allow_sending_without_reply: true,
  };

  // The owner's replies can also contain media.
  // Photos, videos, documents, voice messages, and stickers are forwarded
  // using their original file_id.
  const media = mediaDescriptor(message);
  if (media) {
    await forwardOwnerMedia(env, message, route, media, replyParameters);
    return;
  }

  const content =
    typeof message.text === "string"
      ? message.text
      : typeof message.caption === "string"
        ? message.caption
        : "";

  if (!content.trim()) {
    // Do not silently drop empty replies or unsupported messages.
    // Tell the owner how to send a valid reply instead.
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "Unable to forward this reply. Send a text message or add a caption to your media.",
      reply_parameters: { message_id: message.message_id },
    });
    return;
  }

  await telegram(env, "sendMessage", {
    chat_id: route.chatId,
    text: truncate(content, MAX_TEXT_LENGTH),
    reply_parameters: replyParameters,
  });
}

async function forwardOwnerMedia(env, message, route, media, replyParameters) {
  const caption = typeof message.caption === "string" ? message.caption.trim() : "";

  try {
    if (media.kind === "sticker") {
      await telegram(env, "sendSticker", {
        chat_id: route.chatId,
        sticker: media.fileId,
        reply_parameters: replyParameters,
      });
      return;
    }

    if (media.kind === "video_note") {
      await telegram(env, "sendVideoNote", {
        chat_id: route.chatId,
        video_note: media.fileId,
        reply_parameters: replyParameters,
      });
      return;
    }

    const params = {
      chat_id: route.chatId,
      [media.field]: media.fileId,
      reply_parameters: replyParameters,
    };
    if (caption) {
      params.caption = truncate(caption, MAX_CAPTION_LENGTH);
    }

    await telegram(env, media.method, params);
  } catch (error) {
    console.error(`Failed to forward owner's ${media.method ?? media.kind}:`, error);

    // If media forwarding fails, at least send the caption as text.
    // If there is no caption, notify the owner about the failure.
    if (caption) {
      await telegram(env, "sendMessage", {
        chat_id: route.chatId,
        text: truncate(caption, MAX_TEXT_LENGTH),
        reply_parameters: replyParameters,
      });
      return;
    }

    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "Failed to forward the media. Please try another file or send a text message instead.",
      reply_parameters: { message_id: message.message_id },
    });
  }
}

/**
 * Notification format (the second line always contains routing information):
 *
 *   John Doe (@johndoe) sent you a message:
 *   123456789-42
 *   Hello!
 */
function buildNotification(message, chatId, limit, content) {
  const header = `${displayName(message.from)} sent you a message:`;
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

  // Animations also contain a document field, so check animation first.
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

  // Names may contain newlines, so strip them to ensure the route is always
  // on the second line.
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
  return "unsupported message type";
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

  // message_id must be a positive integer.
  // Reject malformed or tampered routing information.
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
      "Usage:",
      "1. Reply directly to a notification forwarded by the bot to message the original sender.",
      "2. Reply with /spam to block a user, or /unspam to unblock them.",
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

  // Avoid splitting a UTF-16 surrogate pair, which could leave an invalid
  // surrogate and cause Telegram to reject the message.
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
    console.error(`Telegram ${method} request failed:`, error);
    return null;
  }
}

async function telegram(env, method, params) {
  if (!env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not configured.");
  }

  const response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    // Prevent Telegram API requests from hanging long enough to time out
    // the webhook and trigger duplicate update deliveries.
    signal: AbortSignal.timeout(10_000),
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Telegram ${method} returned a non-JSON response (HTTP ${response.status})`);
  }

  if (!result?.ok) {
    throw new Error(
      `Telegram ${method} failed (${result?.error_code ?? response.status}): ${
        result?.description ?? "Unknown error"
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
