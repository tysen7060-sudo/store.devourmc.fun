"use strict";

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
  text,
  validUrl
} = require("./_discord");

const cooldown = new Map();
const COOLDOWN_MS = 60 * 1000;

function clientKey(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}

module.exports = async function handler(req, res) {
  if (!methodGuard(req, res)) return;
  try {
    const key = clientKey(req);
    const now = Date.now();
    if ((cooldown.get(key) || 0) > now) {
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
    const profileLink = required(body.profileLink, "Profile link");
    const followers = Number(body.followers);
    const averageViews = Number(body.averageViews);
    const contentTypes = Array.isArray(body.contentTypes) ? body.contentTypes.map(item => text(item, 80)).filter(Boolean) : [];
    const reason = required(body.reason, "Reason");
    const frequency = required(body.frequency, "Content frequency");
    const previousExperience = required(body.previousExperience, "Previous experience");

    if (!Number.isFinite(age) || age <= 0) throw new RequestError("Age must be a valid positive number.", 400, "VALIDATION_ERROR");
    if (!validUrl(profileLink)) throw new RequestError("Channel or profile link must be a valid URL.", 400, "VALIDATION_ERROR");
    if (!Number.isFinite(followers) || followers < 0) throw new RequestError("Followers or subscribers must not be negative.", 400, "VALIDATION_ERROR");
    if (!Number.isFinite(averageViews) || averageViews < 0) throw new RequestError("Average views must not be negative.", 400, "VALIDATION_ERROR");
    if (!contentTypes.length) throw new RequestError("Select at least one content type.", 400, "VALIDATION_ERROR");
    if (reason.length < 30) throw new RequestError("Reason must be at least 30 characters.", 400, "VALIDATION_ERROR");
    if (body.agreement !== true) throw new RequestError("Agreement is required.", 400, "VALIDATION_ERROR");

    for (const keyName of ["youtube", "instagram", "twitch", "x", "otherLink"]) {
      if (body[keyName] && !validUrl(body[keyName])) {
        throw new RequestError(`${keyName} must be a valid URL.`, 400, "VALIDATION_ERROR");
      }
    }

    const referenceId = `MEDIA-${now.toString(36).toUpperCase()}`;
    await sendDiscordWebhook(process.env.DISCORD_MEDIA_APPLICATION_WEBHOOK_URL, {
      embeds: [
        embed("New Media Application", [
          field("Reference ID", referenceId, true),
          field("Minecraft Username", minecraftUsername, true),
          field("Discord Username", discordUsername, true),
          field("Age", numberText(age), true),
          field("Main Platform", mainPlatform, true),
          field("Main Profile", profileLink),
          field("Followers/Subscribers", numberText(followers), true),
          field("Average Views", numberText(averageViews), true),
          field("Content Types", contentTypes.join(", ")),
          field("Frequency", frequency),
          field("Previous Minecraft Server Content", previousExperience, true),
          field("Previous Experience Details", multiline(body.previousDetails, 700)),
          field("Reason for Applying", multiline(reason, 1000)),
          field("YouTube", text(body.youtube) || "Not provided"),
          field("Instagram", text(body.instagram) || "Not provided"),
          field("Twitch", text(body.twitch) || "Not provided"),
          field("X", text(body.x) || "Not provided"),
          field("Other Portfolio", text(body.otherLink) || "Not provided"),
          field("Additional Information", multiline(body.additionalInfo, 700)),
          field("Submitted", new Date(now).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))
        ])
      ]
    });

    cooldown.set(key, now + COOLDOWN_MS);
    res.status(200).json({ success: true, referenceId });
  } catch (error) {
    console.warn("Media application webhook failed:", error?.code || error?.message || "unknown");
    safeError(res, error, "Media application could not be submitted.");
  }
};
