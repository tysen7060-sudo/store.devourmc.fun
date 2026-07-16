"use strict";

const CACHE_TTL_MS = 30 * 1000;
const OWNER_CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;
const TEAM_OWNER_LOOKUP_CONCURRENCY = 4;
const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cache = new Map();
const ownerNameCache = new Map();

class DevourApiError extends Error {
  constructor(message, statusCode = 502, code = "DEVOUR_API_ERROR") {
    super(message);
    this.name = "DevourApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function validateEnvironment() {
  const baseUrl = process.env.DEVOUR_API_URL;
  const apiKey = process.env.DEVOUR_API_KEY;

  if (!baseUrl) {
    throw new DevourApiError("DevourAPI is not configured.", 500, "MISSING_DEVOUR_API_URL");
  }

  if (!apiKey) {
    throw new DevourApiError("DevourAPI is not configured.", 500, "MISSING_DEVOUR_API_KEY");
  }

  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new DevourApiError("DevourAPI is not configured correctly.", 500, "INVALID_DEVOUR_API_URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new DevourApiError("DevourAPI is not configured correctly.", 500, "INVALID_DEVOUR_API_URL");
  }

  return { baseUrl: parsed.toString(), apiKey };
}

function joinUrl(baseUrl, path, query) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const normalizedPath = String(path || "").replace(/^\/+/, "");
  const url = new URL(normalizedPath, normalizedBase);

  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function sanitizeQuery(req) {
  const source = req.query || {};
  const sanitized = {};

  for (const key of ["limit", "page", "pageSize"]) {
    const raw = Array.isArray(source[key]) ? source[key][0] : source[key];
    if (raw === undefined) continue;
    const value = Number.parseInt(String(raw), 10);
    if (Number.isFinite(value) && value > 0) {
      sanitized[key] = Math.min(value, 100);
    }
  }

  return sanitized;
}

function validateEnvelope(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DevourApiError("DevourAPI returned an invalid response.", 502, "INVALID_DEVOUR_API_RESPONSE");
  }

  if (typeof payload.success !== "boolean" || !Object.prototype.hasOwnProperty.call(payload, "data")) {
    throw new DevourApiError("DevourAPI returned an invalid response.", 502, "INVALID_DEVOUR_API_RESPONSE");
  }

  if (payload.meta !== undefined && (payload.meta === null || typeof payload.meta !== "object" || Array.isArray(payload.meta))) {
    throw new DevourApiError("DevourAPI returned an invalid response.", 502, "INVALID_DEVOUR_API_RESPONSE");
  }

  if (payload.error !== null && payload.error !== undefined && (typeof payload.error !== "object" || Array.isArray(payload.error))) {
    throw new DevourApiError("DevourAPI returned an invalid response.", 502, "INVALID_DEVOUR_API_RESPONSE");
  }

  if (payload.success !== true) {
    throw new DevourApiError("DevourAPI rejected the request.", 502, "DEVOUR_API_REJECTED");
  }

  return payload;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    throw new DevourApiError("DevourAPI returned invalid JSON.", 502, "INVALID_DEVOUR_API_JSON");
  }
}

async function fetchDevour(path, req) {
  const { baseUrl, apiKey } = validateEnvironment();
  const query = sanitizeQuery(req);
  const url = joinUrl(baseUrl, path, query);
  const cacheKey = `${path}?${url.searchParams.toString()}`;
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new DevourApiError("DevourAPI request timed out.", 504, "DEVOUR_API_TIMEOUT");
    }
    throw new DevourApiError("DevourAPI is temporarily unavailable.", 502, "DEVOUR_API_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }

  const payload = await readJson(response);

  if (!response.ok) {
    throw new DevourApiError("DevourAPI returned an error.", 502, "DEVOUR_API_HTTP_ERROR");
  }

  const validated = validateEnvelope(payload);
  cache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    payload: validated
  });

  return validated;
}

function firstText(source, keys) {
  if (!source || typeof source !== "object") return "";
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function extractUsername(payload) {
  const data = payload && payload.data;
  const direct = firstText(data, ["username", "name", "playerName", "displayName"]);
  if (direct) return direct;

  const profile = data && data.profile;
  const fromProfile = firstText(profile, ["username", "name", "playerName", "displayName"]);
  if (fromProfile) return fromProfile;

  const player = data && data.player;
  return firstText(player, ["username", "name", "playerName", "displayName"]);
}

function ownerFields(entry) {
  const ownerName = firstText(entry, ["ownerName", "leaderName", "ownerUsername", "leaderUsername"]);
  const ownerUuid = firstText(entry, ["ownerUuid", "leaderUuid"]);
  const owner = firstText(entry, ["owner", "leader"]);

  if (ownerName && !looksLikeUuid.test(ownerName)) {
    return { ownerName, ownerUuid: ownerUuid || (looksLikeUuid.test(owner) ? owner : null) };
  }

  if (ownerName && looksLikeUuid.test(ownerName)) {
    return { ownerName: null, ownerUuid: ownerName };
  }

  if (ownerUuid && looksLikeUuid.test(ownerUuid)) {
    return { ownerName: null, ownerUuid };
  }

  if (owner && looksLikeUuid.test(owner)) {
    return { ownerName: null, ownerUuid: owner };
  }

  if (owner) {
    return { ownerName: owner, ownerUuid: null };
  }

  return { ownerName: null, ownerUuid: null };
}

async function fetchOwnerName(uuid) {
  const cached = ownerNameCache.get(uuid);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const { baseUrl, apiKey } = validateEnvironment();
  const url = joinUrl(baseUrl, `/players/${encodeURIComponent(uuid)}/profile`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      ownerNameCache.set(uuid, {
        expiresAt: Date.now() + OWNER_CACHE_TTL_MS,
        value: null
      });
      return null;
    }

    const payload = validateEnvelope(await readJson(response));
    const username = extractUsername(payload);
    const value = username && !looksLikeUuid.test(username) ? username : null;
    ownerNameCache.set(uuid, {
      expiresAt: Date.now() + OWNER_CACHE_TTL_MS,
      value
    });
    return value;
  } catch {
    ownerNameCache.set(uuid, {
      expiresAt: Date.now() + OWNER_CACHE_TTL_MS,
      value: null
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function resolveTeamOwners(payload) {
  if (!Array.isArray(payload.data)) return payload;

  const entries = payload.data.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const owner = ownerFields(entry);
    return {
      ...entry,
      ownerUuid: owner.ownerUuid || null,
      ownerName: owner.ownerName || null
    };
  });

  const uuids = [...new Set(entries
    .map(entry => entry && typeof entry === "object" ? entry.ownerUuid : null)
    .filter(uuid => uuid && looksLikeUuid.test(uuid))
  )];

  const unresolvedUuids = uuids.filter(uuid => {
    const cached = ownerNameCache.get(uuid);
    return !cached || cached.expiresAt <= Date.now();
  });

  await mapWithConcurrency(unresolvedUuids, TEAM_OWNER_LOOKUP_CONCURRENCY, fetchOwnerName);

  const enriched = entries.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    let ownerName = entry.ownerName;
    if (!ownerName && entry.ownerUuid) {
      ownerName = ownerNameCache.get(entry.ownerUuid)?.value || "Unknown Owner";
    }
    if (!ownerName || looksLikeUuid.test(ownerName)) {
      ownerName = "Unknown Owner";
    }
    return {
      ...entry,
      ownerName
    };
  });

  return {
    ...payload,
    data: enriched
  };
}

function errorEnvelope(error) {
  const safe = error instanceof DevourApiError
    ? error
    : new DevourApiError("Leaderboard data is temporarily unavailable.", 502, "DEVOUR_API_ERROR");

  return {
    statusCode: safe.statusCode,
    body: {
      success: false,
      data: null,
      meta: {
        timestamp: new Date().toISOString()
      },
      error: {
        code: safe.code,
        message: safe.message
      }
    }
  };
}

function createHandler(path, options = {}) {
  return async function handler(req, res) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.status(405).json({
        success: false,
        data: null,
        meta: { timestamp: new Date().toISOString() },
        error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." }
      });
      return;
    }

    try {
      let payload = await fetchDevour(path, req);
      if (options.resolveTeamOwners) {
        payload = await resolveTeamOwners(payload);
      }
      res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=30");
      res.status(200).json(payload);
    } catch (error) {
      const { statusCode, body } = errorEnvelope(error);
      res.setHeader("Cache-Control", "no-store");
      res.status(statusCode).json(body);
    }
  };
}

module.exports = {
  createHandler
};
