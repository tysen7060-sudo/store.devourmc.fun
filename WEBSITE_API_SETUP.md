# DevourMC Website API Setup

This static Vercel site uses same-origin Node.js API Functions as a secure bridge to DevourAPI.

## Required Vercel Environment Variables

Set these in the Vercel project settings for Production, Preview, and Development as needed:

```text
DEVOUR_API_URL=http://your-api-host/api/v1
DEVOUR_API_KEY=your_private_api_key
DISCORD_PURCHASE_WEBHOOK_URL=
DISCORD_SUPPORT_WEBHOOK_URL=
DISCORD_MEDIA_APPLICATION_WEBHOOK_URL=
DISCORD_BOT_TOKEN=
DISCORD_ABANDONED_CHECKOUT_CHANNEL_ID=
DISCORD_GUILD_ID=
DISCORD_ANNOUNCEMENTS_CHANNEL_ID=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
APP_BASE_URL=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

Do not add real secrets to Git files, browser JavaScript, HTML, URLs, query parameters, logs, or responses.

## Discord Integrations

Add these values in Vercel Project Settings -> Environment Variables. Keep them server-side only.

- `DISCORD_PURCHASE_WEBHOOK_URL`: Discord webhook for confirmed purchase notifications.
- `DISCORD_SUPPORT_WEBHOOK_URL`: Discord webhook for support form notifications.
- `DISCORD_MEDIA_APPLICATION_WEBHOOK_URL`: Discord webhook for media creator applications.
- `DISCORD_BOT_TOKEN`: Bot token used by `/api/discord?action=announcements` and `/api/discord?action=abandoned-checkout`.
- `DISCORD_ABANDONED_CHECKOUT_CHANNEL_ID`: Channel ID where the existing Discord bot posts abandoned checkout messages.
- `DISCORD_GUILD_ID`: Discord server ID used to build message links.
- `DISCORD_ANNOUNCEMENTS_CHANNEL_ID`: Announcements channel ID read by the bot.

The Discord bot only needs permission to view the announcements channel and read message history for server updates. For abandoned checkout messages, the same existing bot must be in the Discord server and must have View Channel, Send Messages, and Read Message History permissions in the abandoned checkout channel. Administrator permission is not required. The browser never receives webhook URLs, channel IDs, or the bot token.

### Abandoned Checkout Bot Messages

Configure a Discord channel for abandoned checkout messages:

1. In Discord, open the staff/log channel that should receive abandoned checkout notifications.
2. Copy the channel ID.
3. Confirm the existing DevourMC Discord bot can View Channel, Send Messages, and Read Message History in that channel.
4. In Vercel, open Project -> Settings -> Environment Variables.
5. Add `DISCORD_ABANDONED_CHECKOUT_CHANNEL_ID` for Production, Preview, and Development.
6. Confirm `DISCORD_BOT_TOKEN` is also configured for the same environments.
7. Redeploy after adding the environment variable.

Abandoned checkout delivery does not use a webhook. It sends one normal Discord channel message through the existing bot using Discord's channel message API.

Abandoned checkout notifications send only one plain text line in this format:

```text
yoo MinecraftUsername, random message
```

The website does not use Discord login, Discord OAuth, account linking, user DMs, Discord user IDs, role mentions, `@everyone`, or `@here`. The bot message payload sets `allowed_mentions: { parse: [] }` so usernames cannot ping anyone even if they contain Discord-looking text.

The abandoned checkout endpoint is:

```text
/api/discord?action=abandoned-checkout
```

Discord-related website actions are consolidated into one Vercel Function to stay within Hobby plan function limits:

```text
/api/discord?action=announcements
/api/discord?action=media-application
/api/discord?action=support
/api/discord?action=purchase
/api/discord?action=abandoned-checkout
```

## Razorpay Standard Checkout

Payment actions are handled by the existing consolidated Vercel Function through the `/api/payments` rewrite. This keeps the deployed Serverless Function count within the Vercel Hobby limit.

```text
POST /api/payments?action=create-order
POST /api/payments?action=verify-payment
POST /api/payments?action=webhook
GET  /api/payments?action=order-status&orderId=...
```

Set these in Vercel Project -> Settings -> Environment Variables for Production, Preview, and Development:

- `RAZORPAY_KEY_ID`: Razorpay public key ID. This is the only Razorpay value returned to the browser for checkout.
- `RAZORPAY_KEY_SECRET`: Razorpay secret used server-side to create orders and verify payment signatures.
- `RAZORPAY_WEBHOOK_SECRET`: Secret configured on the Razorpay webhook endpoint.
- `APP_BASE_URL`: Public site URL, for example `https://devourmc.fun`.
- `UPSTASH_REDIS_REST_URL`: Persistent Redis REST URL used for order records and idempotency.
- `UPSTASH_REDIS_REST_TOKEN`: Persistent Redis REST token.

Do not prefix secret values with `VITE_`, `NEXT_PUBLIC_`, or `PUBLIC_`. Do not commit real Razorpay, Redis, or Discord secrets.

### Razorpay Webhook Setup

In the Razorpay dashboard, configure the webhook URL:

```text
https://your-domain.example/api/payments?action=webhook
```

Use Test Mode first. Add the same webhook secret to `RAZORPAY_WEBHOOK_SECRET` in Vercel. Enable successful payment events such as `payment.captured`.

### Server-Side Pricing and Storage

The browser sends only Minecraft username, product IDs, quantities, and coupon code. The Vercel Function reloads trusted store prices from server-side configuration, validates `LAUNCH20`, recalculates subtotal, discount, and final payable amount, then creates the Razorpay order in paise.

Persistent storage is required before payments are accepted. The implementation uses Upstash Redis REST for:

- internal order records
- Razorpay order to internal order mapping
- Razorpay payment idempotency keys
- paid/fulfilled/purchase-notified state

For Razorpay Test Mode debugging, the API can fall back to in-memory order storage so the Standard Checkout popup can be opened and tested. This fallback is not production-safe because Vercel serverless instances can restart or run in parallel. Configure Upstash Redis before switching to Live Mode.

### Payment Fulfilment Rules

The website does not mark a checkout complete when the customer clicks Continue to Payment. It tracks separate states for checkout started, payment started, and payment confirmed. Only server-side Razorpay signature verification or a verified Razorpay webhook can mark the order paid.

The Purchase Discord notification is sent only after verified payment. Duplicate frontend verification, webhook retries, and refreshes are guarded by persistent Razorpay payment ID idempotency keys.

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
