"use strict";

const {
  RequestError,
  methodGuard,
  multiline,
  readJsonBody,
  required,
  safeError,
  text
} = require("./_discord");

const { abandonedCheckoutMessages } = require("../data/abandoned-checkout-messages");

const deliveredSessions = new Set();
const processingSessions = new Set();
const MAX_DELIVERED_SESSIONS = 500;
const VALID_ITEM_TYPES = new Set(["rank", "crate", "credits"]);
const DISCORD_TIMEOUT_MS = 8 * 1000;

function escapeDiscordMarkdown(value, max = 1000) {
  return multiline(value, max)
    .replace(/([\\`*_{}\[\]()#+\-.!|>~])/g, "\\$1")
    .replace(/@/g, "@\u200b");
}

function validSessionId(value) {
  return /^checkout_[A-Za-z0-9_-]{8,80}$/.test(String(value || ""));
}

function positiveNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new RequestError(`${fieldName} is invalid.`, 400, "VALIDATION_ERROR");
  }
  return number;
}

function positiveQuantity(value) {
  const quantity = Number.parseInt(String(value), 10);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999) {
    throw new RequestError("Cart quantity is invalid.", 400, "VALIDATION_ERROR");
  }
  return quantity;
}

function normalizeItem(item) {
  const type = text(item?.type, 30).toLowerCase();
  if (!VALID_ITEM_TYPES.has(type)) {
    throw new RequestError("Cart contains an unsupported item.", 400, "VALIDATION_ERROR");
  }
  const name = required(item?.name, "Item name");
  const quantity = positiveQuantity(item?.qty ?? item?.quantity);
  const price = positiveNumber(item?.price, "Item price");
  return { type, name, quantity, price };
}

function randomMessage() {
  const messages = abandonedCheckoutMessages.filter(Boolean);
  if (!messages.length) return "Buy krle bhai, checkout pe chord diya T-T";
  return messages[Math.floor(Math.random() * messages.length)];
}

function rememberSession(sessionId) {
  deliveredSessions.add(sessionId);
  if (deliveredSessions.size > MAX_DELIVERED_SESSIONS) {
    const first = deliveredSessions.values().next().value;
    deliveredSessions.delete(first);
  }
}

async function sendBotChannelMessage(content) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_ABANDONED_CHECKOUT_CHANNEL_ID;
  if (!token) throw new RequestError("Discord bot token is not configured.", 500, "BOT_NOT_CONFIGURED");
  if (!/^\d{16,25}$/.test(String(channelId || ""))) {
    throw new RequestError("Discord abandoned checkout channel is not configured.", 500, "CHANNEL_NOT_CONFIGURED");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new RequestError("Discord bot message delivery failed.", 502, "BOT_MESSAGE_FAILED");
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new RequestError("Discord bot message delivery timed out.", 504, "BOT_MESSAGE_TIMEOUT");
    }
    if (error instanceof RequestError) throw error;
    throw new RequestError("Discord bot message delivery failed.", 502, "BOT_MESSAGE_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res)) return;

  let sessionId = "";
  try {
    const body = await readJsonBody(req, 16 * 1024);
    sessionId = required(body.checkoutSessionId || body.sessionId, "Checkout session ID");
    if (!validSessionId(sessionId)) {
      throw new RequestError("Checkout session ID is invalid.", 400, "VALIDATION_ERROR");
    }

    if (deliveredSessions.has(sessionId) || processingSessions.has(sessionId)) {
      res.status(200).json({ success: true, duplicate: true });
      return;
    }
    processingSessions.add(sessionId);

    const username = required(body.minecraftUsername || body.username, "Minecraft username");
    if (username.length > 32) {
      throw new RequestError("Minecraft username is too long.", 400, "VALIDATION_ERROR");
    }

    const cart = Array.isArray(body.cart) ? body.cart : [];
    if (!cart.length) {
      throw new RequestError("Cart is empty.", 400, "VALIDATION_ERROR");
    }
    const items = cart.map(normalizeItem);

    const order = body.orderDetails && typeof body.orderDetails === "object" ? body.orderDetails : {};
    const subtotal = positiveNumber(order.subtotalBeforeDiscount ?? body.subtotal, "Subtotal");
    const discount = positiveNumber(order.discountAmount ?? body.discountAmount ?? 0, "Discount");
    const finalTotal = positiveNumber(order.finalTotal ?? body.finalTotal, "Final total");
    if (finalTotal < 0) {
      throw new RequestError("Final total is invalid.", 400, "VALIDATION_ERROR");
    }

    const safeMinecraftUsername = escapeDiscordMarkdown(username, 80).replace(/\n+/g, " ");
    const message = escapeDiscordMarkdown(randomMessage(), 160).replace(/\n+/g, " ");
    const finalMessage = `yoo ${safeMinecraftUsername}, ${message}`.slice(0, 2000);

    await sendBotChannelMessage(finalMessage);

    rememberSession(sessionId);
    processingSessions.delete(sessionId);
    res.status(200).json({ success: true });
  } catch (error) {
    if (sessionId) processingSessions.delete(sessionId);
    console.warn("Abandoned checkout bot message skipped/failed:", error?.code || error?.message || "unknown");
    safeError(res, error, "Abandoned checkout notification could not be delivered.");
  }
};
