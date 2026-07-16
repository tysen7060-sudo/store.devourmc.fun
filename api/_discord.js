"use strict";

const WEBHOOK_TIMEOUT_MS = 8 * 1000;
const MAX_JSON_BYTES = 32 * 1024;

class RequestError extends Error {
  constructor(message, statusCode = 400, code = "BAD_REQUEST") {
    super(message);
    this.name = "RequestError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function methodGuard(req, res, method = "POST") {
  if (req.method !== method) {
    res.setHeader("Allow", method);
    res.status(405).json({ success: false, error: "Method not allowed." });
    return false;
  }
  return true;
}

async function readJsonBody(req, maxBytes = MAX_JSON_BYTES) {
  if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString("utf8"));
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return parseJson(req.body);

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new RequestError("Request body is too large.", 413, "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  return parseJson(Buffer.concat(chunks).toString("utf8"));
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid JSON object");
    return parsed;
  } catch {
    throw new RequestError("Invalid JSON payload.", 400, "INVALID_JSON");
  }
}

function text(value, max = 1000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function multiline(value, max = 1800) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function numberText(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : "";
}

function validUrl(value) {
  if (!value) return false;
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function required(value, field) {
  const result = text(value);
  if (!result) throw new RequestError(`${field} is required.`, 400, "VALIDATION_ERROR");
  return result;
}

function field(name, value, inline = false) {
  const safeValue = multiline(value, 1024) || "Not provided";
  return { name: text(name, 256) || "Field", value: safeValue, inline };
}

function embed(title, fields, description = "") {
  return {
    title: text(title, 256),
    description: multiline(description, 4096),
    color: 0x8b5cf6,
    timestamp: new Date().toISOString(),
    fields: fields.filter(Boolean).slice(0, 25)
  };
}

async function sendDiscordWebhook(webhookUrl, payload) {
  if (!webhookUrl) throw new RequestError("Discord webhook is not configured.", 500, "WEBHOOK_NOT_CONFIGURED");
  if (!validUrl(webhookUrl)) throw new RequestError("Discord webhook is not configured correctly.", 500, "WEBHOOK_INVALID");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) {
      throw new RequestError("Discord webhook delivery failed.", 502, "WEBHOOK_DELIVERY_FAILED");
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new RequestError("Discord webhook delivery timed out.", 504, "WEBHOOK_TIMEOUT");
    }
    if (error instanceof RequestError) throw error;
    throw new RequestError("Discord webhook delivery failed.", 502, "WEBHOOK_DELIVERY_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

function safeError(res, error, fallback = "Request could not be processed.") {
  const statusCode = Number(error?.statusCode) || 500;
  res.status(statusCode).json({
    success: false,
    error: statusCode >= 500 ? fallback : error.message || fallback,
    code: error?.code || "REQUEST_FAILED"
  });
}

module.exports = {
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
};
