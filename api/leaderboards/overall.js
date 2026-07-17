"use strict";

const { errorEnvelope, fetchDevourPayload } = require("../_devourClient");

const SUPPLEMENTAL_LEADERBOARDS = [
  { id: "kills", path: "/leaderboards/kills", rawField: "kills", formattedField: "formattedKills" },
  { id: "money", path: "/leaderboards/money", rawField: "money", formattedField: "formattedMoney" },
  { id: "deaths", path: "/leaderboards/deaths", rawField: "deaths", formattedField: "formattedDeaths" },
  { id: "gems", path: "/leaderboards/gems", rawField: "gems", formattedField: "formattedGems" },
  { id: "credits", path: "/leaderboards/credits", rawField: "credits", formattedField: "formattedCredits" },
  { id: "playtime", path: "/leaderboards/playtime", rawField: "playtime", formattedField: "formattedPlaytime" }
];

function extractEntries(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.entries)) return payload.data.entries;
  if (Array.isArray(payload?.entries)) return payload.entries;
  return [];
}

function playerKey(entry) {
  const uuid = String(entry?.uuid ?? "").trim().toLowerCase();
  if (uuid) return `uuid:${uuid}`;

  const username = String(entry?.username ?? entry?.name ?? "").trim().toLowerCase();
  return username ? `name:${username}` : "";
}

function metricMap(payload, config) {
  const map = new Map();
  for (const entry of extractEntries(payload)) {
    const key = playerKey(entry);
    if (!key) continue;
    map.set(key, {
      rawValue: entry?.[config.rawField] ?? entry?.rawValue ?? null,
      formattedValue: safeText(entry?.[config.formattedField] ?? entry?.formattedValue)
    });
  }
  return map;
}

function safeText(value) {
  if (value === undefined || value === null) return "";
  const text = String(value).trim();
  if (!text || text === "undefined" || text === "null" || text === "NaN") return "";
  return text;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatInteger(value) {
  const number = finiteNumber(value);
  return number === null ? "Unavailable" : Math.trunc(number).toLocaleString("en-US");
}

function formatMoney(value) {
  const number = finiteNumber(value);
  if (number === null) return "Unavailable";
  const sign = number < 0 ? "-" : "";
  const abs = Math.abs(number);
  if (abs >= 1_000_000_000) return `${sign}$${trimNumber(abs / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${sign}$${trimNumber(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  return `${sign}$${trimNumber(abs)}`;
}

function formatScore(value) {
  const number = finiteNumber(value);
  return number === null ? "Unavailable" : trimNumber(number.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0
  }));
}

function trimNumber(value) {
  return String(value).replace(/(\.\d*?[1-9])0+$/u, "$1").replace(/\.0+$/u, "");
}

function formattedMetric(metric, formatter) {
  if (!metric) return "Unavailable";
  return safeText(metric.formattedValue) || formatter(metric.rawValue);
}

function rawMetric(metric) {
  if (!metric || metric.rawValue === undefined || metric.rawValue === null) return null;
  return metric.rawValue;
}

function supplementalRequest(req) {
  return {
    query: {
      ...(req.query || {}),
      limit: 100
    }
  };
}

function logSupplementalFailure(config, error) {
  console.warn("Supplemental leaderboard request failed", {
    endpoint: config.id,
    upstreamStatus: error?.upstreamStatus || null,
    code: error?.code || "DEVOUR_API_ERROR"
  });
}

module.exports = async function overallLeaderboardHandler(req, res) {
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
    const results = await Promise.allSettled([
      fetchDevourPayload("/leaderboards/overall", req),
      ...SUPPLEMENTAL_LEADERBOARDS.map(config => fetchDevourPayload(config.path, supplementalRequest(req)))
    ]);

    const [overallResult, ...supplementalResults] = results;

    if (overallResult.status !== "fulfilled") {
      throw overallResult.reason;
    }

    const supplementalMaps = {};
    supplementalResults.forEach((result, index) => {
      const config = SUPPLEMENTAL_LEADERBOARDS[index];
      if (result.status === "fulfilled") {
        supplementalMaps[config.id] = metricMap(result.value, config);
      } else {
        logSupplementalFailure(config, result.reason);
        supplementalMaps[config.id] = new Map();
      }
    });

    const enriched = extractEntries(overallResult.value).map((entry, index) => {
      const key = playerKey(entry);
      const metrics = Object.fromEntries(SUPPLEMENTAL_LEADERBOARDS.map(config => [
        config.id,
        key ? supplementalMaps[config.id]?.get(key) : null
      ]));
      const overallRaw = entry?.overallScore ?? entry?.score ?? entry?.rawValue ?? null;
      const overallFormatted = safeText(entry?.formattedOverallScore ?? entry?.formattedScore ?? entry?.formattedValue) || formatScore(overallRaw);

      return {
        position: Number.parseInt(String(entry?.position ?? index + 1), 10) || index + 1,
        uuid: entry?.uuid ?? null,
        username: safeText(entry?.username ?? entry?.name) || "Unknown Player",
        avatarUrl: safeText(entry?.avatarUrl),
        kills: rawMetric(metrics.kills),
        formattedKills: formattedMetric(metrics.kills, formatInteger),
        money: rawMetric(metrics.money),
        formattedMoney: formattedMetric(metrics.money, formatMoney),
        deaths: rawMetric(metrics.deaths),
        formattedDeaths: formattedMetric(metrics.deaths, formatInteger),
        gems: rawMetric(metrics.gems),
        formattedGems: formattedMetric(metrics.gems, formatInteger),
        credits: rawMetric(metrics.credits),
        formattedCredits: formattedMetric(metrics.credits, formatInteger),
        playtime: rawMetric(metrics.playtime),
        formattedPlaytime: formattedMetric(metrics.playtime, () => "Unavailable"),
        overallScore: overallRaw,
        formattedOverallScore: overallFormatted,
        rawValue: overallRaw,
        formattedValue: overallFormatted,
        lastUpdated: entry?.lastUpdated ?? null
      };
    });

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=30");
    res.status(200).json({
      success: true,
      data: enriched,
      meta: {
        ...(overallResult.value.meta || {}),
        timestamp: overallResult.value.meta?.timestamp || new Date().toISOString(),
        cached: overallResult.value.meta?.cached ?? true
      },
      error: null
    });
  } catch (error) {
    const { statusCode, body } = errorEnvelope(error);
    res.setHeader("Cache-Control", "no-store");
    res.status(statusCode).json(body);
  }
};
