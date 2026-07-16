# DevourMC Website API Setup

This static Vercel site uses same-origin Node.js API Functions as a secure bridge to DevourAPI.

## Required Vercel Environment Variables

Set these in the Vercel project settings for Production, Preview, and Development as needed:

```text
DEVOUR_API_URL=http://your-api-host/api/v1
DEVOUR_API_KEY=your_private_api_key
```

Do not add real secrets to Git files, browser JavaScript, HTML, URLs, query parameters, logs, or responses.

## Request Flow

```text
Browser
-> same-origin /api/* Vercel Function
-> DevourAPI with server-side Bearer token
```

The browser only calls same-origin website endpoints such as:

```text
/api/leaderboards/kills?limit=10
```

The Vercel Function sends this server-side header to DevourAPI:

```text
Authorization: Bearer ${DEVOUR_API_KEY}
Accept: application/json
```

## Internal Website Endpoints

Player leaderboards:

```text
/api/leaderboards/overall
/api/leaderboards/money
/api/leaderboards/kills
/api/leaderboards/playtime
```

Team leaderboards:

```text
/api/teams/overall
/api/teams/kills
/api/teams/balance
/api/teams/members
```

## Upstream DevourAPI Endpoints

The functions call:

```text
${DEVOUR_API_URL}/leaderboards/overall
${DEVOUR_API_URL}/leaderboards/money
${DEVOUR_API_URL}/leaderboards/kills
${DEVOUR_API_URL}/leaderboards/playtime
${DEVOUR_API_URL}/teams/overall
${DEVOUR_API_URL}/teams/kills
${DEVOUR_API_URL}/teams/balance
${DEVOUR_API_URL}/teams/members
```

Supported query parameters forwarded to DevourAPI are `limit`, `page`, and `pageSize`.

## Local Development

Use the Vercel CLI or deploy to Vercel to run the API Functions. Opening `index.html` directly will render the static frontend, but live leaderboard requests require the Vercel Function runtime.

## Notes

The provided JSON samples show the DevourAPI envelope and unauthorized error shape, but not successful leaderboard entry fields or the playtime unit. The website therefore uses safe fallbacks and never displays `undefined`, `null`, or `NaN` when a successful payload is missing display fields.
