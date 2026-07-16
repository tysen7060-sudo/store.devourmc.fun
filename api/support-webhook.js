"use strict";

const {
  embed,
  field,
  methodGuard,
  multiline,
  readJsonBody,
  required,
  safeError,
  sendDiscordWebhook,
  text
} = require("./_discord");

module.exports = async function handler(req, res) {
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
};
