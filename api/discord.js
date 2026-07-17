"use strict";

const crypto = require("crypto");

const {
  RequestError,
  embed,
  field,
  methodGuard,
  multiline,
  numberText,
  readJsonBody,
  required,
  safeError,
  sendDiscordWebhook,
  text
} = require("./_discord");

const { abandonedCheckoutMessages } = require("../data/abandoned-checkout-messages");

const mediaCooldown = new Map();
const MEDIA_COOLDOWN_MS = 60 * 1000;
const deliveredPurchases = new Set();
const deliveredAbandonedSessions = new Set();
const processingAbandonedSessions = new Set();
const MAX_DELIVERED_SESSIONS = 500;
const VALID_ABANDONED_ITEM_TYPES = new Set(["rank", "crate", "credits"]);
const DISCORD_TIMEOUT_MS = 8 * 1000;
const ANNOUNCEMENT_CACHE_TTL_MS = 120 * 1000;
const DISCORD_GUILD_META_CACHE_TTL_MS = 10 * 60 * 1000;
const SERVER_STATUS_CACHE_TTL_MS = 60 * 1000;
const DEFAULT_ROLE_COLOR = "#9b8cff";
const PAYMENT_STORAGE_PREFIX = "devourmc:payment-order:";
const RAZORPAY_ORDER_PREFIX = "devourmc:razorpay-order:";
const RAZORPAY_PAYMENT_PREFIX = "devourmc:razorpay-payment:";
const STORE_PRODUCTS = {
  rank: {
    elite: { id: "elite", name: "ELITE Rank", category: "Rank", pricePaise: 9900 },
    cosmic: { id: "cosmic", name: "COSMIC Rank", category: "Rank", pricePaise: 19900 },
    archon: { id: "archon", name: "ARCHON Rank", category: "Rank", pricePaise: 24900 },
    celestial: { id: "celestial", name: "CELESTIAL Rank", category: "Rank", pricePaise: 29900 },
    ascendant: { id: "ascendant", name: "ASCENDANT Rank", category: "Rank", pricePaise: 34900 },
    custom: { id: "custom", name: "CUSTOM Rank", category: "Rank", pricePaise: 49900 }
  },
  crate: {
    titan: { id: "titan", name: "Titan Crate Key", category: "Crate", pricePaise: 3900 },
    reaper: { id: "reaper", name: "Reaper Crate Key", category: "Crate", pricePaise: 5900 },
    omega: { id: "omega", name: "Omega Crate Key", category: "Crate", pricePaise: 9900 },
    royal: { id: "royal", name: "Royal Crate Key", category: "Crate", pricePaise: 12900 }
  }
};
const SERVER_COUPONS = [
  {
    code: "LAUNCH20",
    discountType: "percentage",
    discountValue: 20,
    active: true,
    minimumOrderAmountPaise: 0,
    maximumDiscountAmountPaise: null,
    expiresAt: null,
    applicableCategories: ["all"]
  }
];
let announcementCache = { expiresAt: 0, data: null };
let guildMetaCache = { expiresAt: 0, roles: new Map(), channels: new Map() };
let serverStatusCache = { expiresAt: 0, data: null };
const memoryPaymentStore = new Map();

function clientKey(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}

function validYouTubeChannelUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const path = parsed.pathname.toLowerCase();
    return host === "youtube.com" && (
      path.startsWith("/@") ||
      path.startsWith("/channel/") ||
      path.startsWith("/c/")
    );
  } catch {
    return false;
  }
}

function validKickChannelUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    return host === "kick.com" && parsed.pathname.split("/").filter(Boolean).length >= 1;
  } catch {
    return false;
  }
}

function cleanMessage(content) {
  return String(content || "").trim().slice(0, 1800);
}

function imageAttachments(message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  return attachments
    .filter(attachment => String(attachment.content_type || "").startsWith("image/"))
    .map(attachment => ({
      url: attachment.url,
      filename: attachment.filename || "Announcement image"
    }))
    .slice(0, 2);
}

function normalizedEmbeds(message) {
  const embeds = Array.isArray(message.embeds) ? message.embeds : [];
  return embeds
    .slice(0, 2)
    .map(item => ({
      title: text(item.title, 180),
      description: multiline(item.description, 700),
      image: text(item.image?.url || item.thumbnail?.url, 500)
    }))
    .filter(item => item.title || item.description || item.image);
}

function roleColorHex(color) {
  const number = Number(color);
  if (!Number.isFinite(number) || number <= 0) return DEFAULT_ROLE_COLOR;
  return `#${number.toString(16).padStart(6, "0").slice(-6)}`;
}

function discordAvatarUrl(user, size = 64) {
  const id = String(user?.id || "");
  const avatar = String(user?.avatar || "");
  if (!/^\d{16,25}$/.test(id) || !avatar) return "";
  const ext = avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${encodeURIComponent(id)}/${encodeURIComponent(avatar)}.${ext}?size=${size}`;
}

function discordDisplayName(author, member) {
  return text(member?.nick || member?.global_name || author?.global_name || author?.username, 120) || "DevourMC Staff";
}

function normalizeDiscordAuthor(message) {
  const author = message?.author || {};
  return {
    id: text(author.id, 40),
    displayName: discordDisplayName(author, message?.member),
    username: text(author.username, 80),
    avatarUrl: discordAvatarUrl(author, 80),
    bot: Boolean(author.bot),
    webhook: Boolean(message?.webhook_id)
  };
}

async function discordApiGet(token, path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
  try {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Discord status ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function getGuildMeta(token, guildId) {
  if (!/^\d{16,25}$/.test(String(guildId || ""))) {
    return { roles: new Map(), channels: new Map() };
  }
  if (guildMetaCache.expiresAt > Date.now()) return guildMetaCache;

  const [rolesResult, channelsResult] = await Promise.allSettled([
    discordApiGet(token, `/guilds/${encodeURIComponent(guildId)}/roles`),
    discordApiGet(token, `/guilds/${encodeURIComponent(guildId)}/channels`)
  ]);

  const roles = new Map();
  if (rolesResult.status === "fulfilled" && Array.isArray(rolesResult.value)) {
    for (const role of rolesResult.value) {
      if (!role?.id) continue;
      roles.set(String(role.id), {
        id: String(role.id),
        name: text(role.name, 100) || "Role",
        color: roleColorHex(role.color)
      });
    }
  }

  const channels = new Map();
  if (channelsResult.status === "fulfilled" && Array.isArray(channelsResult.value)) {
    for (const channel of channelsResult.value) {
      if (!channel?.id) continue;
      channels.set(String(channel.id), {
        id: String(channel.id),
        name: text(channel.name, 100) || "channel"
      });
    }
  }

  guildMetaCache = {
    expiresAt: Date.now() + DISCORD_GUILD_META_CACHE_TTL_MS,
    roles,
    channels
  };
  return guildMetaCache;
}

function normalizeUserMention(user) {
  return {
    id: text(user?.id, 40),
    displayName: text(user?.member?.nick || user?.global_name || user?.username, 120) || "User"
  };
}

function mentionedRoleIds(content, message) {
  const ids = new Set(Array.isArray(message?.mention_roles) ? message.mention_roles.map(String) : []);
  String(content || "").replace(/<@&(\d{16,25})>/g, (_, id) => {
    ids.add(id);
    return "";
  });
  return [...ids];
}

function mentionedChannels(content, message, guildMeta) {
  const resolved = new Map();
  const channels = Array.isArray(message?.mention_channels) ? message.mention_channels : [];
  for (const channel of channels) {
    if (!channel?.id) continue;
    resolved.set(String(channel.id), {
      id: String(channel.id),
      name: text(channel.name, 100) || "channel"
    });
  }
  String(content || "").replace(/<#(\d{16,25})>/g, (_, id) => {
    if (!resolved.has(id)) {
      resolved.set(id, guildMeta.channels.get(id) || { id, name: "channel" });
    }
    return "";
  });
  return [...resolved.values()];
}

function normalizeAnnouncement(message, channelId, guildId, guildMeta) {
  const content = cleanMessage(message.content);
  const roleMentions = mentionedRoleIds(content, message).map(id => guildMeta.roles.get(id) || {
    id,
    name: "Role",
    color: DEFAULT_ROLE_COLOR
  });
  const userMentions = (Array.isArray(message.mentions) ? message.mentions : [])
    .map(normalizeUserMention)
    .filter(user => user.id);
  const channelMentions = mentionedChannels(content, message, guildMeta);
  const embeds = normalizedEmbeds(message);

  return {
    id: message.id,
    content,
    timestamp: message.timestamp,
    createdAt: message.timestamp,
    author: normalizeDiscordAuthor(message),
    pinned: Boolean(message.pinned),
    url: guildId ? `https://discord.com/channels/${guildId}/${channelId}/${message.id}` : "",
    attachments: imageAttachments(message),
    embeds,
    roleMentions,
    userMentions,
    channelMentions
  };
}

function escapeDiscordMarkdown(value, max = 1000) {
  return multiline(value, max)
    .replace(/([\\`*_{}\[\]()#+\-.!|>~])/g, "\\$1")
    .replace(/@/g, "@\u200b");
}

function validCheckoutSessionId(value) {
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

function validMinecraftUsername(value) {
  return /^[A-Za-z0-9_]{3,16}$/.test(String(value || ""));
}

function paymentStorageConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function paymentStoreCommand(args) {
  if (!paymentStorageConfigured()) {
    return memoryPaymentStoreCommand(args);
  }
  const response = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    throw new RequestError("Payment storage request failed.", 502, "PAYMENT_STORAGE_FAILED");
  }
  return payload.result;
}

function memoryPaymentStoreCommand(args) {
  const [command, key, value, mode] = args;
  const normalized = String(command || "").toUpperCase();
  console.warn("Payment storage is using in-memory fallback. Configure Upstash Redis before Live Mode.");
  if (normalized === "GET") {
    return memoryPaymentStore.get(key) || null;
  }
  if (normalized === "SET") {
    if (String(mode || "").toUpperCase() === "NX" && memoryPaymentStore.has(key)) {
      return null;
    }
    memoryPaymentStore.set(key, value);
    return "OK";
  }
  throw new RequestError("Payment storage command is unsupported.", 500, "PAYMENT_STORAGE_FAILED");
}

async function setPaymentRecord(key, value) {
  await paymentStoreCommand(["SET", key, JSON.stringify(value)]);
}

async function getPaymentRecord(key) {
  const value = await paymentStoreCommand(["GET", key]);
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

async function setPaymentIdempotencyKey(key, value) {
  const result = await paymentStoreCommand(["SET", key, value, "NX"]);
  return result === "OK";
}

function paiseToRupees(value) {
  return Math.max(0, Math.round(Number(value) || 0)) / 100;
}

function formatInrPaise(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(paiseToRupees(value));
}

function normalizeCouponCode(code) {
  return String(code || "").trim().toUpperCase();
}

function findServerCoupon(code) {
  const normalized = normalizeCouponCode(code);
  if (!normalized) return null;
  return SERVER_COUPONS.find(coupon => normalizeCouponCode(coupon.code) === normalized) || null;
}

function productCategoryKey(product) {
  const category = String(product?.category || "").toLowerCase();
  if (category === "rank") return "ranks";
  if (category === "crate") return "crates";
  if (category === "credits") return "credits";
  return category || "unknown";
}

function couponAppliesToProduct(coupon, product) {
  const categories = Array.isArray(coupon?.applicableCategories) ? coupon.applicableCategories : ["all"];
  const normalized = categories.map(item => String(item || "").trim().toLowerCase()).filter(Boolean);
  if (!normalized.length || normalized.includes("all")) return true;
  const category = productCategoryKey(product);
  return normalized.includes(category) || (category === "credits" && normalized.includes("credit-shop"));
}

function validateServerCoupon(coupon, products) {
  if (!coupon) return { valid: false, couponCode: "", discountPaise: 0 };
  const discountValue = Number(coupon.discountValue);
  if (!coupon.active || coupon.discountType !== "percentage" || !Number.isFinite(discountValue) || discountValue <= 0 || discountValue > 100) {
    return { valid: false, couponCode: "", discountPaise: 0 };
  }
  if (coupon.expiresAt) {
    const expiresAt = new Date(coupon.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      return { valid: false, couponCode: "", discountPaise: 0 };
    }
  }
  const eligiblePaise = products.reduce((sum, item) => couponAppliesToProduct(coupon, item) ? sum + item.lineTotalPaise : sum, 0);
  if (eligiblePaise <= 0 || eligiblePaise < Number(coupon.minimumOrderAmountPaise || 0)) {
    return { valid: false, couponCode: "", discountPaise: 0 };
  }
  let discountPaise = Math.round(eligiblePaise * (discountValue / 100));
  if (coupon.maximumDiscountAmountPaise !== null && coupon.maximumDiscountAmountPaise !== undefined) {
    discountPaise = Math.min(discountPaise, Number(coupon.maximumDiscountAmountPaise) || 0);
  }
  return {
    valid: true,
    couponCode: normalizeCouponCode(coupon.code),
    discountType: coupon.discountType,
    discountValue,
    discountPaise: Math.max(0, discountPaise)
  };
}

function normalizePaymentItem(item) {
  const type = text(item?.type, 30).toLowerCase();
  const id = text(item?.id, 80).toLowerCase();
  const quantity = positiveQuantity(item?.quantity ?? item?.qty);
  if (type === "rank") {
    const product = STORE_PRODUCTS.rank[id];
    if (!product) throw new RequestError("Invalid rank product.", 400, "INVALID_PRODUCT");
    console.info("Payment product matched:", { receivedId: id, matchedId: product.id, type, quantity: 1, pricePaise: product.pricePaise });
    return { ...product, type, quantity: 1, lineTotalPaise: product.pricePaise };
  }
  if (type === "crate") {
    const product = STORE_PRODUCTS.crate[id];
    if (!product) throw new RequestError("Invalid crate product.", 400, "INVALID_PRODUCT");
    const safeQuantity = Math.min(quantity, 64);
    console.info("Payment product matched:", { receivedId: id, matchedId: product.id, type, quantity: safeQuantity, pricePaise: product.pricePaise });
    return { ...product, type, quantity: safeQuantity, lineTotalPaise: product.pricePaise * safeQuantity };
  }
  if (type === "credits") {
    const match = /^credits-(\d+)$/.exec(id);
    const amount = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(amount) || amount < 50 || amount > 5000 || amount % 50 !== 0) {
      throw new RequestError("Invalid credits product.", 400, "INVALID_PRODUCT");
    }
    const credits = (amount / 50) * 165;
    const safeQuantity = Math.min(quantity, 99);
    const pricePaise = amount * 100;
    console.info("Payment product matched:", { receivedId: id, matchedId: id, type, quantity: safeQuantity, pricePaise });
    return {
      id,
      type,
      name: `${credits} DevourMC Credits`,
      category: "Credits",
      quantity: safeQuantity,
      pricePaise,
      lineTotalPaise: pricePaise * safeQuantity
    };
  }
  throw new RequestError("Unsupported product type.", 400, "INVALID_PRODUCT");
}

function calculateTrustedOrder(body) {
  const minecraftUsername = required(body.minecraftUsername || body.username, "Minecraft username");
  if (!validMinecraftUsername(minecraftUsername)) {
    throw new RequestError("Minecraft username is invalid.", 400, "VALIDATION_ERROR");
  }
  const requestedItems = Array.isArray(body.items) ? body.items : [];
  if (!requestedItems.length) throw new RequestError("Cart is empty.", 400, "VALIDATION_ERROR");
  const products = requestedItems.map(normalizePaymentItem);
  const subtotalPaise = products.reduce((sum, item) => sum + item.lineTotalPaise, 0);
  const requestedCoupon = normalizeCouponCode(body.couponCode);
  const coupon = findServerCoupon(requestedCoupon);
  const couponResult = requestedCoupon ? validateServerCoupon(coupon, products) : { valid: false, couponCode: "", discountPaise: 0 };
  if (requestedCoupon && !couponResult.valid) {
    throw new RequestError("Coupon is invalid or not applicable.", 400, "COUPON_INVALID");
  }
  const discountPaise = Math.min(subtotalPaise, couponResult.discountPaise || 0);
  const finalTotalPaise = Math.max(0, subtotalPaise - discountPaise);
  if (subtotalPaise <= 0 || finalTotalPaise <= 0) {
    throw new RequestError("Order total must be greater than zero.", 400, "INVALID_TOTAL");
  }
  return {
    minecraftUsername,
    products,
    currency: "INR",
    subtotalPaise,
    couponCode: couponResult.couponCode || "",
    discountType: couponResult.discountType || "",
    discountValue: couponResult.discountValue || 0,
    discountPaise,
    finalTotalPaise
  };
}

function paymentEnv() {
  const keyId = text(process.env.RAZORPAY_KEY_ID, 120);
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || "").trim();
  const appBaseUrl = text(process.env.APP_BASE_URL, 300);
  if (!keyId) throw new RequestError("RAZORPAY_KEY_ID is missing.", 500, "RAZORPAY_KEY_ID_MISSING");
  if (!keySecret) throw new RequestError("RAZORPAY_KEY_SECRET is missing.", 500, "RAZORPAY_KEY_SECRET_MISSING");
  if (!appBaseUrl) throw new RequestError("APP_BASE_URL is missing.", 500, "APP_BASE_URL_MISSING");
  if (!keyId.startsWith("rzp_test_")) {
    throw new RequestError("Razorpay Test Mode key ID must begin with rzp_test_.", 500, "RAZORPAY_MODE_MISMATCH");
  }
  console.info("Razorpay environment detected:", {
    keyIdPrefix: keyId.slice(0, 9),
    hasKeySecret: true,
    hasAppBaseUrl: true,
    storage: paymentStorageConfigured() ? "upstash" : "memory-test-fallback"
  });
  return { keyId, keySecret, appBaseUrl };
}

function createRazorpayClient() {
  const { keyId, keySecret } = paymentEnv();
  let Razorpay;
  try {
    Razorpay = require("razorpay");
  } catch {
    throw new RequestError("Razorpay SDK dependency is missing.", 500, "RAZORPAY_SDK_MISSING");
  }
  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret
  });
}

async function createRazorpayOrder(body) {
  const razorpay = createRazorpayClient();
  try {
    return await razorpay.orders.create(body);
  } catch (error) {
    const razorpayError = error?.error || error;
    console.warn("Razorpay order create failed:", {
      statusCode: error?.statusCode || error?.status,
      code: razorpayError?.code || "unknown",
      reason: razorpayError?.reason || "unknown",
      description: text(razorpayError?.description || error?.message, 300)
    });
    throw new RequestError(text(razorpayError?.description, 300) || "Payment order could not be created.", 502, "ORDER_CREATION_FAILED");
  }
}

function verifyRazorpayCheckoutSignature(orderId, paymentId, signature) {
  const { keySecret } = paymentEnv();
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(expected, received) {
  const a = Buffer.from(String(expected || ""), "utf8");
  const b = Buffer.from(String(received || ""), "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readRawBody(req, maxBytes = 256 * 1024) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "utf8");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new RequestError("Request body is too large.", 413, "BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function verifyRazorpayWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new RequestError("Razorpay webhook is not configured.", 500, "WEBHOOK_NOT_CONFIGURED");
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqual(expected, signature);
}

function internalOrderId() {
  return `DMC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

function safeOrderResponse(order) {
  return {
    internalOrderId: order.internalOrderId,
    razorpayOrderId: order.razorpayOrderId,
    status: order.status,
    currency: order.currency,
    amount: order.finalTotalPaise,
    subtotal: paiseToRupees(order.subtotalPaise),
    discount: paiseToRupees(order.discountPaise),
    finalTotal: paiseToRupees(order.finalTotalPaise),
    couponCode: order.couponCode || "",
    products: order.products.map(item => ({
      id: item.id,
      type: item.type,
      name: item.name,
      category: item.category,
      quantity: item.quantity
    }))
  };
}

function normalizeAbandonedItem(item) {
  const type = text(item?.type, 30).toLowerCase();
  if (!VALID_ABANDONED_ITEM_TYPES.has(type)) {
    throw new RequestError("Cart contains an unsupported item.", 400, "VALIDATION_ERROR");
  }
  const name = required(item?.name, "Item name");
  const quantity = positiveQuantity(item?.qty ?? item?.quantity);
  const price = positiveNumber(item?.price, "Item price");
  return { type, name, quantity, price };
}

function randomAbandonedMessage() {
  const messages = abandonedCheckoutMessages.filter(Boolean);
  if (!messages.length) return "Buy krle bhai, checkout pe chord diya T-T";
  return messages[Math.floor(Math.random() * messages.length)];
}

function rememberAbandonedSession(sessionId) {
  deliveredAbandonedSessions.add(sessionId);
  if (deliveredAbandonedSessions.size > MAX_DELIVERED_SESSIONS) {
    const first = deliveredAbandonedSessions.values().next().value;
    deliveredAbandonedSessions.delete(first);
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

async function handleAnnouncements(req, res) {
  if (!methodGuard(req, res, "GET")) return;
  try {
    const token = process.env.DISCORD_BOT_TOKEN;
    const channelId = process.env.DISCORD_ANNOUNCEMENTS_CHANNEL_ID;
    if (!token || !channelId) {
      res.status(200).json({ success: true, data: [], configured: false, cached: false });
      return;
    }

    if (announcementCache.data && announcementCache.expiresAt > Date.now()) {
      res.status(200).json({ success: true, data: announcementCache.data, cached: true });
      return;
    }

    const limit = Math.min(Math.max(Number.parseInt(String(req.query?.limit || "5"), 10) || 5, 1), 5);
    const guildId = process.env.DISCORD_GUILD_ID || "";
    const [messages, guildMeta] = await Promise.all([
      discordApiGet(token, `/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`),
      getGuildMeta(token, guildId)
    ]);
    const data = (Array.isArray(messages) ? messages : [])
      .filter(message => cleanMessage(message.content) || imageAttachments(message).length || normalizedEmbeds(message).length)
      .map(message => normalizeAnnouncement(message, channelId, guildId, guildMeta));

    announcementCache = { expiresAt: Date.now() + ANNOUNCEMENT_CACHE_TTL_MS, data };
    res.status(200).json({ success: true, data, cached: false });
  } catch (error) {
    console.warn("Discord announcements unavailable:", error?.message || "unknown");
    safeError(res, error, "Server updates are temporarily unavailable.");
  }
}

async function handleMediaApplication(req, res) {
  if (!methodGuard(req, res)) return;
  try {
    const key = clientKey(req);
    const now = Date.now();
    if ((mediaCooldown.get(key) || 0) > now) {
      throw new RequestError("Please wait before submitting another application.", 429, "RATE_LIMITED");
    }

    const body = await readJsonBody(req);
    if (body.botcheck) {
      res.status(200).json({ success: true });
      return;
    }

    const minecraftUsername = required(body.minecraftUsername, "Minecraft username");
    const discordUsername = required(body.discordUsername, "Discord username");
    const age = Number(body.age);
    const mainPlatform = required(body.mainPlatform, "Main platform");
    const youtubeUrl = text(body.youtubeUrl, 500);
    const kickUrl = text(body.kickUrl, 500);
    const followers = Number(body.followers);
    const averageViews = Number(body.averageViews);
    const contentTypes = Array.isArray(body.contentTypes) ? body.contentTypes.map(item => text(item, 80)).filter(Boolean) : [];
    const reason = required(body.reason, "Reason");
    const frequency = required(body.frequency, "Content frequency");
    const previousExperience = required(body.previousExperience, "Previous experience");

    if (!Number.isFinite(age) || age <= 0) throw new RequestError("Age must be a valid positive number.", 400, "VALIDATION_ERROR");
    if (!["YouTube", "Kick", "Both"].includes(mainPlatform)) throw new RequestError("Select a valid main platform.", 400, "VALIDATION_ERROR");
    if (!youtubeUrl && !kickUrl) throw new RequestError("Please provide at least one YouTube or Kick channel link.", 400, "VALIDATION_ERROR");
    if (youtubeUrl && !validYouTubeChannelUrl(youtubeUrl)) throw new RequestError("Enter a valid YouTube channel URL.", 400, "VALIDATION_ERROR");
    if (kickUrl && !validKickChannelUrl(kickUrl)) throw new RequestError("Enter a valid Kick channel URL.", 400, "VALIDATION_ERROR");
    if (mainPlatform === "YouTube" && !youtubeUrl) throw new RequestError("Enter a valid YouTube channel URL.", 400, "VALIDATION_ERROR");
    if (mainPlatform === "Kick" && !kickUrl) throw new RequestError("Enter a valid Kick channel URL.", 400, "VALIDATION_ERROR");
    if (mainPlatform === "Both" && (!youtubeUrl || !kickUrl)) throw new RequestError("Please provide both YouTube and Kick channel links.", 400, "VALIDATION_ERROR");
    if (!Number.isFinite(followers) || followers < 0) throw new RequestError("Followers or subscribers must not be negative.", 400, "VALIDATION_ERROR");
    if (!Number.isFinite(averageViews) || averageViews < 0) throw new RequestError("Average views must not be negative.", 400, "VALIDATION_ERROR");
    if (!contentTypes.length) throw new RequestError("Select at least one content type.", 400, "VALIDATION_ERROR");
    if (reason.length < 30) throw new RequestError("Reason must be at least 30 characters.", 400, "VALIDATION_ERROR");
    if (body.agreement !== true) throw new RequestError("Agreement is required.", 400, "VALIDATION_ERROR");

    const referenceId = `MEDIA-${now.toString(36).toUpperCase()}`;
    const creatorLinkFields = [
      youtubeUrl ? field("YouTube Channel Link", youtubeUrl) : null,
      kickUrl ? field("Kick Channel Link", kickUrl) : null
    ].filter(Boolean);
    await sendDiscordWebhook(process.env.DISCORD_MEDIA_APPLICATION_WEBHOOK_URL, {
      embeds: [
        embed("New Media Application", [
          field("Reference ID", referenceId, true),
          field("Minecraft Username", minecraftUsername, true),
          field("Discord Username", discordUsername, true),
          field("Age", numberText(age), true),
          field("Main Platform", mainPlatform, true),
          ...creatorLinkFields,
          field("Followers/Subscribers", numberText(followers), true),
          field("Average Views", numberText(averageViews), true),
          field("Content Types", contentTypes.join(", ")),
          field("Frequency", frequency),
          field("Previous Minecraft Server Content", previousExperience, true),
          field("Previous Experience Details", multiline(body.previousDetails, 700)),
          field("Reason for Applying", multiline(reason, 1000)),
          field("Additional Information", multiline(body.additionalInfo, 700)),
          field("Submitted", new Date(now).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))
        ])
      ]
    });

    mediaCooldown.set(key, now + MEDIA_COOLDOWN_MS);
    res.status(200).json({ success: true, referenceId });
  } catch (error) {
    console.warn("Media application webhook failed:", error?.code || error?.message || "unknown");
    safeError(res, error, "Media application could not be submitted.");
  }
}

async function handleSupport(req, res) {
  if (!methodGuard(req, res)) return;
  try {
    const body = await readJsonBody(req);
    const name = required(body.name, "Name");
    const email = required(body.email, "Email");
    const category = required(body.category, "Support category");
    const subject = required(body.subjectLine, "Subject");
    const message = required(body.message, "Message");
    if (body.botcheck) {
      res.status(200).json({ success: true });
      return;
    }

    const referenceId = `SUP-${Date.now().toString(36).toUpperCase()}`;
    await sendDiscordWebhook(process.env.DISCORD_SUPPORT_WEBHOOK_URL, {
      embeds: [
        embed("New Support Request", [
          field("Reference ID", referenceId, true),
          field("Name", name, true),
          field("Minecraft Username", text(body.ign) || "Not provided", true),
          field("Email", email, true),
          field("Discord Username", text(body.discord) || "Not provided", true),
          field("Category", category, true),
          field("Subject", subject),
          field("Message", multiline(message, 1000)),
          field("Submitted", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))
        ])
      ]
    });

    res.status(200).json({ success: true, referenceId });
  } catch (error) {
    console.warn("Support Discord webhook failed:", error?.code || error?.message || "unknown");
    safeError(res, error, "Support notification could not be delivered.");
  }
}

async function sendPurchaseDiscordNotification(body) {
  const products = Array.isArray(body.products) ? body.products : [];
  await sendDiscordWebhook(process.env.DISCORD_PURCHASE_WEBHOOK_URL, {
    embeds: [
      embed("New DevourMC Purchase", [
        field("Player", required(body.minecraftUsername, "Minecraft username"), true),
        field("Customer Email", text(body.email) || "Not collected", true),
        field("Customer Discord", text(body.discordUsername) || "Not collected", true),
        field("Products", products.length ? products.map(item => `${text(item.name)} x ${Number(item.quantity) || 1} (${text(item.category) || "item"})`).join("\n") : "Not provided"),
        field("Subtotal", `${text(body.currency || "INR")} ${text(body.subtotal)}`, true),
        field("Coupon", text(body.couponCode) || "None", true),
        field("Discount", text(body.discountAmount || body.discountValue) || "None", true),
        field("Final Paid", `${text(body.currency || "INR")} ${text(body.finalPaid)}`, true),
        field("Internal Order ID", text(body.internalOrderId || body.orderId || body.orderReference), true),
        field("Razorpay Order ID", text(body.razorpayOrderId) || "Not provided", true),
        field("Payment ID", text(body.paymentId) || "Not provided", true),
        field("Payment Status", text(body.paymentStatus), true),
        field("Website Order Reference", text(body.orderReference || body.internalOrderId || body.orderId)),
        field("Date", new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })),
        field("Notes", multiline(body.notes, 500))
      ])
    ]
  });
}

async function handlePurchase(req, res) {
  if (!methodGuard(req, res)) return;
  try {
    const body = await readJsonBody(req);
    const paymentStatus = text(body.paymentStatus).toLowerCase();
    if (!["paid", "captured", "succeeded", "success", "completed"].includes(paymentStatus)) {
      throw new RequestError("Purchase is not confirmed.", 400, "PAYMENT_NOT_CONFIRMED");
    }

    const orderId = required(body.orderId || body.paymentId || body.orderReference, "Order ID");
    if (deliveredPurchases.has(orderId)) {
      res.status(200).json({ success: true, duplicate: true });
      return;
    }

    await sendPurchaseDiscordNotification({ ...body, orderId });

    deliveredPurchases.add(orderId);
    res.status(200).json({ success: true });
  } catch (error) {
    console.warn("Purchase Discord webhook skipped/failed:", error?.code || error?.message || "unknown");
    safeError(res, error, "Purchase notification could not be delivered.");
  }
}

function normalizeServerStatusPayload(payload) {
  const online = Boolean(payload?.online);
  const playersOnline = Number(payload?.players?.online);
  const playersMax = Number(payload?.players?.max);
  return {
    success: true,
    data: {
      online,
      playersOnline: online && Number.isFinite(playersOnline) ? Math.max(0, Math.trunc(playersOnline)) : null,
      playersMax: online && Number.isFinite(playersMax) ? Math.max(0, Math.trunc(playersMax)) : null,
      source: "mcsrvstat"
    },
    cached: false
  };
}

async function fetchMinecraftServerStatus() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.mcsrvstat.us/3/devourmc.fun", {
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      throw new RequestError("Minecraft server status lookup failed.", 502, "SERVER_STATUS_FAILED");
    }
    return normalizeServerStatusPayload(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

async function handleServerStatus(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ success: false, error: "Method not allowed." });
    return;
  }

  try {
    if (serverStatusCache.expiresAt > Date.now() && serverStatusCache.data) {
      res.status(200).json({ ...serverStatusCache.data, cached: true });
      return;
    }

    const data = await fetchMinecraftServerStatus();
    serverStatusCache = {
      expiresAt: Date.now() + SERVER_STATUS_CACHE_TTL_MS,
      data
    };
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
    res.status(200).json(data);
  } catch (error) {
    console.warn("Minecraft server status lookup failed:", error?.code || error?.message || "unknown");
    res.status(502).json({
      success: false,
      error: "Server status is temporarily unavailable."
    });
  }
}

async function handleCreateRazorpayOrder(req, res) {
  if (!methodGuard(req, res)) return;
  try {
    paymentEnv();
    const body = await readJsonBody(req);
    const trusted = calculateTrustedOrder(body);
    console.info("Payment order total calculated:", {
      items: trusted.products.length,
      subtotalPaise: trusted.subtotalPaise,
      discountPaise: trusted.discountPaise,
      finalTotalPaise: trusted.finalTotalPaise,
      currency: trusted.currency
    });
    const id = internalOrderId();
    const receipt = id.slice(0, 40);
    const razorpayOrder = await createRazorpayOrder({
      amount: trusted.finalTotalPaise,
      currency: trusted.currency,
      receipt,
      notes: {
        internalOrderId: id,
        minecraftUsername: trusted.minecraftUsername
      }
    });
    if (!razorpayOrder?.id) {
      throw new RequestError("Payment order could not be created.", 502, "RAZORPAY_ORDER_FAILED");
    }
    const now = new Date().toISOString();
    const order = {
      internalOrderId: id,
      razorpayOrderId: razorpayOrder.id,
      minecraftUsername: trusted.minecraftUsername,
      products: trusted.products,
      currency: trusted.currency,
      subtotalPaise: trusted.subtotalPaise,
      couponCode: trusted.couponCode,
      discountType: trusted.discountType,
      discountValue: trusted.discountValue,
      discountPaise: trusted.discountPaise,
      finalTotalPaise: trusted.finalTotalPaise,
      status: "created",
      fulfilled: false,
      purchaseNotified: false,
      paymentId: "",
      createdAt: now,
      updatedAt: now
    };
    await setPaymentRecord(`${PAYMENT_STORAGE_PREFIX}${id}`, order);
    await setPaymentRecord(`${RAZORPAY_ORDER_PREFIX}${razorpayOrder.id}`, { internalOrderId: id });

    const { keyId } = paymentEnv();
    const safeOrder = safeOrderResponse(order);
    res.status(200).json({
      success: true,
      internalOrderId: order.internalOrderId,
      razorpayOrderId: order.razorpayOrderId,
      keyId,
      amount: order.finalTotalPaise,
      currency: order.currency,
      order: safeOrder
    });
  } catch (error) {
    console.warn("Razorpay order creation failed:", error?.code || error?.message || "unknown");
    res.status(Number(error?.statusCode) || 500).json({
      success: false,
      error: error?.code || "ORDER_CREATION_FAILED",
      message: error?.message || "Payment order could not be created."
    });
  }
}

async function finalizePaidOrder(order, paymentId, source = "verification") {
  const latest = await getPaymentRecord(`${PAYMENT_STORAGE_PREFIX}${order.internalOrderId}`) || order;
  if (latest.status === "paid" && latest.fulfilled && latest.purchaseNotified) {
    return { order: latest, duplicate: true };
  }

  const idempotencyKey = `${RAZORPAY_PAYMENT_PREFIX}${paymentId}`;
  const firstPaymentUse = await setPaymentIdempotencyKey(idempotencyKey, latest.internalOrderId);
  const now = new Date().toISOString();
  const updated = {
    ...latest,
    status: "paid",
    paymentId,
    verifiedBy: source,
    paidAt: latest.paidAt || now,
    updatedAt: now
  };

  if (firstPaymentUse && !latest.purchaseNotified) {
    try {
      await sendPurchaseDiscordNotification({
        minecraftUsername: updated.minecraftUsername,
        products: updated.products,
        subtotal: formatInrPaise(updated.subtotalPaise),
        couponCode: updated.couponCode || "None",
        discountAmount: formatInrPaise(updated.discountPaise),
        finalPaid: formatInrPaise(updated.finalTotalPaise),
        currency: updated.currency,
        internalOrderId: updated.internalOrderId,
        razorpayOrderId: updated.razorpayOrderId,
        paymentId,
        paymentStatus: "verified"
      });
      updated.purchaseNotified = true;
    } catch (error) {
      console.warn("Verified purchase Discord notification failed:", error?.code || error?.message || "unknown");
    }
  }

  updated.fulfilled = true;
  await setPaymentRecord(`${PAYMENT_STORAGE_PREFIX}${updated.internalOrderId}`, updated);
  return { order: updated, duplicate: !firstPaymentUse };
}

async function handleVerifyRazorpayPayment(req, res) {
  if (!methodGuard(req, res)) return;
  try {
    const body = await readJsonBody(req, 16 * 1024);
    const internalId = required(body.internalOrderId, "Internal order ID");
    const razorpayPaymentId = required(body.razorpay_payment_id, "Razorpay payment ID");
    const razorpayOrderId = required(body.razorpay_order_id, "Razorpay order ID");
    const razorpaySignature = required(body.razorpay_signature, "Razorpay signature");
    const order = await getPaymentRecord(`${PAYMENT_STORAGE_PREFIX}${internalId}`);
    if (!order) throw new RequestError("Order was not found.", 404, "ORDER_NOT_FOUND");
    if (order.razorpayOrderId !== razorpayOrderId) {
      throw new RequestError("Payment order does not match.", 400, "ORDER_MISMATCH");
    }
    if (!verifyRazorpayCheckoutSignature(razorpayOrderId, razorpayPaymentId, razorpaySignature)) {
      throw new RequestError("Payment could not be verified.", 400, "SIGNATURE_INVALID");
    }
    const result = await finalizePaidOrder(order, razorpayPaymentId, "checkout");
    res.status(200).json({
      success: true,
      verified: true,
      duplicate: result.duplicate,
      order: safeOrderResponse(result.order)
    });
  } catch (error) {
    console.warn("Razorpay payment verification failed:", error?.code || error?.message || "unknown");
    safeError(res, error, "Payment could not be verified.");
  }
}

async function handleRazorpayWebhook(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ success: false, error: "Method not allowed." });
    return;
  }
  try {
    const rawBody = await readRawBody(req);
    const signature = text(req.headers["x-razorpay-signature"], 200);
    if (!verifyRazorpayWebhookSignature(rawBody, signature)) {
      throw new RequestError("Webhook signature is invalid.", 400, "WEBHOOK_SIGNATURE_INVALID");
    }
    const event = JSON.parse(rawBody.toString("utf8") || "{}");
    const eventType = text(event?.event, 120);
    if (eventType === "payment.captured") {
      const payment = event?.payload?.payment?.entity || {};
      const paymentId = text(payment.id, 120);
      const razorpayOrderId = text(payment.order_id, 120);
      if (paymentId && razorpayOrderId) {
        const mapping = await getPaymentRecord(`${RAZORPAY_ORDER_PREFIX}${razorpayOrderId}`);
        if (mapping?.internalOrderId) {
          const order = await getPaymentRecord(`${PAYMENT_STORAGE_PREFIX}${mapping.internalOrderId}`);
          if (order) await finalizePaidOrder(order, paymentId, "webhook");
        }
      }
    }
    res.status(200).json({ success: true });
  } catch (error) {
    console.warn("Razorpay webhook handling failed:", error?.code || error?.message || "unknown");
    safeError(res, error, "Webhook could not be processed.");
  }
}

async function handlePaymentOrderStatus(req, res) {
  if (!methodGuard(req, res, "GET")) return;
  try {
    const internalId = required(req.query?.orderId, "Order ID");
    const order = await getPaymentRecord(`${PAYMENT_STORAGE_PREFIX}${internalId}`);
    if (!order) throw new RequestError("Order was not found.", 404, "ORDER_NOT_FOUND");
    res.status(200).json({ success: true, order: safeOrderResponse(order) });
  } catch (error) {
    safeError(res, error, "Order status could not be loaded.");
  }
}

async function handleAbandonedCheckout(req, res) {
  if (!methodGuard(req, res)) return;

  let sessionId = "";
  try {
    const body = await readJsonBody(req, 16 * 1024);
    sessionId = required(body.checkoutSessionId || body.sessionId, "Checkout session ID");
    if (!validCheckoutSessionId(sessionId)) {
      throw new RequestError("Checkout session ID is invalid.", 400, "VALIDATION_ERROR");
    }

    if (deliveredAbandonedSessions.has(sessionId) || processingAbandonedSessions.has(sessionId)) {
      res.status(200).json({ success: true, duplicate: true });
      return;
    }
    processingAbandonedSessions.add(sessionId);

    const paymentOrderId = text(body.paymentOrderId, 120);
    if (paymentOrderId && paymentStorageConfigured()) {
      const order = await getPaymentRecord(`${PAYMENT_STORAGE_PREFIX}${paymentOrderId}`);
      if (order?.status === "paid") {
        rememberAbandonedSession(sessionId);
        processingAbandonedSessions.delete(sessionId);
        res.status(200).json({ success: true, paid: true });
        return;
      }
    }

    const username = required(body.minecraftUsername || body.username, "Minecraft username");
    if (username.length > 32) {
      throw new RequestError("Minecraft username is too long.", 400, "VALIDATION_ERROR");
    }

    const cart = Array.isArray(body.cart) ? body.cart : [];
    if (!cart.length) {
      throw new RequestError("Cart is empty.", 400, "VALIDATION_ERROR");
    }
    cart.map(normalizeAbandonedItem);

    const order = body.orderDetails && typeof body.orderDetails === "object" ? body.orderDetails : {};
    positiveNumber(order.subtotalBeforeDiscount ?? body.subtotal, "Subtotal");
    positiveNumber(order.discountAmount ?? body.discountAmount ?? 0, "Discount");
    const finalTotal = positiveNumber(order.finalTotal ?? body.finalTotal, "Final total");
    if (finalTotal < 0) {
      throw new RequestError("Final total is invalid.", 400, "VALIDATION_ERROR");
    }

    const safeMinecraftUsername = escapeDiscordMarkdown(username, 80).replace(/\n+/g, " ");
    const message = escapeDiscordMarkdown(randomAbandonedMessage(), 160).replace(/\n+/g, " ");
    const finalMessage = `yoo ${safeMinecraftUsername}, ${message}`.slice(0, 2000);

    await sendBotChannelMessage(finalMessage);

    rememberAbandonedSession(sessionId);
    processingAbandonedSessions.delete(sessionId);
    res.status(200).json({ success: true });
  } catch (error) {
    if (sessionId) processingAbandonedSessions.delete(sessionId);
    console.warn("Abandoned checkout bot message skipped/failed:", error?.code || error?.message || "unknown");
    safeError(res, error, "Abandoned checkout notification could not be delivered.");
  }
}

module.exports = async function handler(req, res) {
  let body = null;
  const queryAction = text(req.query?.action, 80).toLowerCase();
  if (req.method !== "GET" && queryAction !== "webhook") {
    try {
      body = await readJsonBody(req);
      req.body = body;
    } catch (error) {
      safeError(res, error, "Discord request could not be processed.");
      return;
    }
  }

  const action = text(queryAction || body?.action, 80).toLowerCase();
  switch (action) {
    case "announcements":
      return handleAnnouncements(req, res);
    case "status":
      return handleServerStatus(req, res);
    case "media-application":
      return handleMediaApplication(req, res);
    case "support":
      return handleSupport(req, res);
    case "purchase":
      return handlePurchase(req, res);
    case "abandoned-checkout":
      return handleAbandonedCheckout(req, res);
    case "create-order":
      return handleCreateRazorpayOrder(req, res);
    case "verify-payment":
      return handleVerifyRazorpayPayment(req, res);
    case "webhook":
      return handleRazorpayWebhook(req, res);
    case "order-status":
      return handlePaymentOrderStatus(req, res);
    default:
      res.status(404).json({ success: false, error: "Unknown action." });
  }
};
