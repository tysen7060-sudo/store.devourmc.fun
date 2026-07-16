"use strict";

const CACHE_TTL_MS = 30 * 1000;
const OWNER_CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;
const TEAM_OWNER_LOOKUP_CONCURRENCY = 4;
const looksLikeUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const cache = new Map();
const playerProfileCache = new Map();

class DevourApiError extends Error {
  constructor(message, statusCode = 502, code = "DEVOUR_API_ERROR", upstreamStatus = null) {
    super(message);
    this.name = "DevourApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
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
    throw new DevourApiError("DevourAPI returned an error.", 502, "DEVOUR_API_HTTP_ERROR", response.status);
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

function extractAvatarUrl(payload) {
  const data = payload && payload.data;
  const direct = firstText(data, ["avatarUrl", "avatar", "headUrl"]);
  if (direct) return direct;

  const profile = data && data.profile;
  const fromProfile = firstText(profile, ["avatarUrl", "avatar", "headUrl"]);
  if (fromProfile) return fromProfile;

  const player = data && data.player;
  return firstText(player, ["avatarUrl", "avatar", "headUrl"]);
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
  const profile = await fetchPlayerProfile(uuid);
  return profile ? profile.username : null;
}

async function fetchPlayerProfile(uuid) {
  const cached = playerProfileCache.get(uuid);
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
      playerProfileCache.set(uuid, {
        expiresAt: Date.now() + OWNER_CACHE_TTL_MS,
        value: null
      });
      return null;
    }

    const payload = validateEnvelope(await readJson(response));
    const username = extractUsername(payload);
    const avatarUrl = extractAvatarUrl(payload);
    const value = username && !looksLikeUuid.test(username)
      ? {
        uuid,
        username,
        avatarUrl: avatarUrl || `https://mc-heads.net/avatar/${encodeURIComponent(uuid)}/128`
      }
      : null;
    playerProfileCache.set(uuid, {
      expiresAt: Date.now() + OWNER_CACHE_TTL_MS,
      value
    });
    return value;
  } catch {
    playerProfileCache.set(uuid, {
      expiresAt: Date.now() + OWNER_CACHE_TTL_MS,
      value: null
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function playerFromFields(entry, uuidKeys, nameKeys, avatarKeys, fallbackName) {
  const name = firstText(entry, nameKeys);
  const uuid = firstText(entry, uuidKeys);
  const avatarUrl = firstText(entry, avatarKeys);

  if (!name && !uuid && !avatarUrl) return null;

  return {
    uuid: uuid && looksLikeUuid.test(uuid) ? uuid : null,
    username: name && !looksLikeUuid.test(name) ? name : fallbackName,
    avatarUrl: avatarUrl || null
  };
}

function memberCandidates(entry) {
  if (Array.isArray(entry.members)) {
    return entry.members.map(member => {
      if (member && typeof member === "object") {
        return playerFromFields(
          member,
          ["uuid", "memberUuid", "playerUuid", "id"],
          ["username", "memberName", "playerName", "name", "displayName"],
          ["avatarUrl", "avatar", "headUrl"],
          "Unknown Player"
        );
      }
      const value = String(member || "").trim();
      if (!value) return null;
      return looksLikeUuid.test(value)
        ? { uuid: value, username: "Unknown Player", avatarUrl: null }
        : { uuid: null, username: value, avatarUrl: null };
    }).filter(Boolean);
  }

  const uuids = Array.isArray(entry.memberUuids) ? entry.memberUuids : [];
  const names = Array.isArray(entry.memberNames) ? entry.memberNames : [];
  const avatars = Array.isArray(entry.memberAvatarUrls) ? entry.memberAvatarUrls : [];
  const size = Math.max(uuids.length, names.length, avatars.length);

  return Array.from({ length: size }, (_, index) => {
    const uuid = String(uuids[index] || "").trim();
    const name = String(names[index] || "").trim();
    const avatarUrl = String(avatars[index] || "").trim();
    if (!uuid && !name && !avatarUrl) return null;
    return {
      uuid: uuid && looksLikeUuid.test(uuid) ? uuid : null,
      username: name && !looksLikeUuid.test(name) ? name : "Unknown Player",
      avatarUrl: avatarUrl || null
    };
  }).filter(Boolean);
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
    const members = memberCandidates(entry);
    return {
      ...entry,
      ownerUuid: owner.ownerUuid || null,
      ownerName: owner.ownerName || null,
      members
    };
  });

  const uuids = [...new Set(entries
    .flatMap(entry => {
      if (!entry || typeof entry !== "object") return [];
      return [
        entry.ownerUuid,
        ...((Array.isArray(entry.members) ? entry.members : []).map(member => member.uuid))
      ];
    })
    .filter(uuid => uuid && looksLikeUuid.test(uuid))
  )];

  const unresolvedUuids = uuids.filter(uuid => {
    const cached = playerProfileCache.get(uuid);
    return !cached || cached.expiresAt <= Date.now();
  });

  await mapWithConcurrency(unresolvedUuids, TEAM_OWNER_LOOKUP_CONCURRENCY, fetchPlayerProfile);

  const enriched = entries.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const leaderProfile = entry.ownerUuid ? playerProfileCache.get(entry.ownerUuid)?.value : null;
    let ownerName = entry.ownerName || leaderProfile?.username;
    if (!ownerName || looksLikeUuid.test(ownerName)) {
      ownerName = "Unknown Owner";
    }
    const leader = {
      uuid: entry.ownerUuid || null,
      username: ownerName,
      avatarUrl: leaderProfile?.avatarUrl || (entry.ownerUuid ? `https://mc-heads.net/avatar/${encodeURIComponent(entry.ownerUuid)}/128` : null)
    };
    const members = (Array.isArray(entry.members) ? entry.members : []).map(member => {
      if (!member || typeof member !== "object") return null;
      const profile = member.uuid ? playerProfileCache.get(member.uuid)?.value : null;
      const username = member.username && member.username !== "Unknown Player" && !looksLikeUuid.test(member.username)
        ? member.username
        : profile?.username || "Unknown Player";
      return {
        uuid: member.uuid || null,
        username,
        avatarUrl: member.avatarUrl || profile?.avatarUrl || (member.uuid ? `https://mc-heads.net/avatar/${encodeURIComponent(member.uuid)}/128` : null)
      };
    }).filter(Boolean);

    if (!members.length && leader.uuid) {
      members.push({
        uuid: leader.uuid,
        username: leader.username === "Unknown Owner" ? "Unknown Player" : leader.username,
        avatarUrl: leader.avatarUrl
      });
    }

    return {
      ...entry,
      ownerName,
      leader,
      members,
      kills: Number.isFinite(Number(entry.totalKills)) ? Number(entry.totalKills) : 0,
      formattedKills: firstText(entry, ["formattedKills"]) || String(Number.isFinite(Number(entry.totalKills)) ? Number(entry.totalKills) : 0),
      balance: Number.isFinite(Number(entry.totalBalance)) ? Number(entry.totalBalance) : 0,
      formattedBalance: firstText(entry, ["formattedBalance"]) || String(Number.isFinite(Number(entry.totalBalance)) ? Number(entry.totalBalance) : 0),
      overallScore: Number.isFinite(Number(entry.overallScore)) ? Number(entry.overallScore) : 0,
      formattedOverallScore: firstText(entry, ["formattedOverallScore"]) || String(Number.isFinite(Number(entry.overallScore)) ? Number(entry.overallScore) : 0)
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
  createHandler,
  DevourApiError,
  errorEnvelope,
  fetchDevourPayload: fetchDevour
};
