"use strict";

const { methodGuard, safeError } = require("./_discord");

const CACHE_TTL_MS = 120 * 1000;
let cache = { expiresAt: 0, data: null };

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

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res, "GET")) return;
  try {
    const token = process.env.DISCORD_BOT_TOKEN;
    const channelId = process.env.DISCORD_ANNOUNCEMENTS_CHANNEL_ID;
    if (!token || !channelId) {
      res.status(200).json({ success: true, data: [], configured: false, cached: false });
      return;
    }

    if (cache.data && cache.expiresAt > Date.now()) {
      res.status(200).json({ success: true, data: cache.data, cached: true });
      return;
    }

    const limit = Math.min(Math.max(Number.parseInt(String(req.query?.limit || "5"), 10) || 5, 1), 5);
    const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`, {
      headers: { Authorization: `Bot ${token}` }
    });

    if (!response.ok) {
      throw new Error(`Discord status ${response.status}`);
    }

    const messages = await response.json();
    const data = (Array.isArray(messages) ? messages : [])
      .filter(message => cleanMessage(message.content) || imageAttachments(message).length)
      .map(message => ({
        id: message.id,
        content: cleanMessage(message.content),
        author: message.author?.username || "DevourMC",
        createdAt: message.timestamp,
        pinned: Boolean(message.pinned),
        url: process.env.DISCORD_GUILD_ID
          ? `https://discord.com/channels/${process.env.DISCORD_GUILD_ID}/${channelId}/${message.id}`
          : "",
        attachments: imageAttachments(message)
      }));

    cache = { expiresAt: Date.now() + CACHE_TTL_MS, data };
    res.status(200).json({ success: true, data, cached: false });
  } catch (error) {
    console.warn("Discord announcements unavailable:", error?.message || "unknown");
    safeError(res, error, "Server updates are temporarily unavailable.");
  }
};
