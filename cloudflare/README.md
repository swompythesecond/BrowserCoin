# Cloudflare Pages Functions

Source of truth for server-side bits of browsercoin.org that can't live in the
static bundle. Currently one: the Discord patch-notes mirror behind
`GET /api/patchnotes`, which feeds the Changelog tab on `/about?tab=changelog`.

These files are **not** part of `npm run build` and never enter `dist/`. They are
copied into the Pages repo once, by hand, and then left alone — the normal
frontend deploy only replaces `index.html`, `assets/`, `_redirects` and
`logo.png`, so `functions/` survives every deploy untouched.

## One-time setup

### 1. Create the Discord bot

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot** tab → **Reset Token** → copy it. This is `DISCORD_BOT_TOKEN`.
   Treat it like a password; anyone holding it can act as the bot.
3. **Bot → Privileged Gateway Intents → enable MESSAGE CONTENT INTENT.** This
   one is mandatory despite the "Gateway" label: Discord applies it to REST
   responses too, and
   [per the docs](https://docs.discord.com/developers/events/gateway)
   "apps without the intent will receive empty values in fields that contain
   user-inputted content" — `content` included. Without it the API returns 200
   with every message blanked, which looks identical to an empty channel. The
   portal only requires app verification for this intent once the bot reaches
   10,000 users, so it is a plain toggle here. Leave Presence and Server Members
   **off**.
4. **OAuth2 → URL Generator**: scope `bot`, permissions **View Channel** +
   **Read Message History**. Nothing else. Open the generated URL and add the
   bot to the BrowserCoin server.
5. On the patch-notes channel: **Edit Channel → Permissions**, add the bot, and
   confirm those two permissions are allowed. A bot that can't see the channel
   returns 403 and the site falls back to "read them on Discord".

### 2. Get the channel ID

Discord → **Settings → Advanced → Developer Mode** on. Right-click the
patch-notes channel → **Copy Channel ID**. That 18–19 digit number is
`DISCORD_CHANNEL_ID`. (A `discord.gg/...` invite link is *not* a channel ID —
it identifies the server, not the channel.)

### 3. Add the secrets to Pages

Cloudflare dashboard → the `BrowserCoin-Cloudflare` Pages project → **Settings →
Environment variables → Production**:

| Name | Value | Type |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | the bot token from step 1 | **Secret** (encrypted) |
| `DISCORD_CHANNEL_ID` | the channel ID from step 2 | Plaintext is fine |

Set `DISCORD_BOT_TOKEN` as a **Secret**, not a plaintext variable — plaintext
values are readable from the dashboard afterwards.

### 4. Copy the function into the Pages repo

```sh
cd C:/Users/Julian/Documents/github/BrowserCoin-Cloudflare
mkdir -p functions/api
cp C:/Users/Julian/Documents/github/browserCoin/cloudflare/functions/api/patchnotes.js functions/api/
git add functions
git commit -m "feat: /api/patchnotes — mirror Discord patch notes"
git push origin main
```

Pushing triggers the Pages build, which picks up `functions/` automatically —
no wrangler config, no build command change.

**The SPA catch-all in `_redirects` does not shadow this.** `_redirects`
contains `/*  /index.html  200`, which looks like it would swallow
`/api/patchnotes`, but it doesn't: per
[Cloudflare's redirects docs](https://developers.cloudflare.com/pages/configuration/redirects/),
"redirects defined in the `_redirects` file are not applied to requests served
by Pages Functions." Functions match first; only unmatched paths fall through to
static assets and `_redirects`. No `_routes.json` is needed.

### 5. Verify

```sh
curl -s https://browsercoin.org/api/patchnotes | head -c 400
```

- `{"ok":true,"entries":[...]}` — working.
- `{"ok":false,"reason":"unconfigured"}` — env vars missing or not deployed to
  the Production environment.
- `{"ok":false,"reason":"forbidden"}` — bad token, or the bot lacks View
  Channel / Read Message History on that channel.
- `{"ok":false,"reason":"missing-message-content-intent"}` — messages were
  returned but every `content` was blank. Turn on MESSAGE CONTENT INTENT
  (step 1.3); no redeploy needed, just wait out the 5-minute edge cache.
- HTML instead of JSON — `functions/` didn't deploy; check it's at the repo
  root, not inside a subdirectory.

## Behaviour

- Newest 50 messages with non-empty text, newest first. Image attachments are
  passed through; other attachment types are dropped.
- Cached at the Cloudflare edge for 5 minutes, so a traffic burst costs one
  Discord API call.
- Failures return HTTP 200 with `ok:false` on purpose. The changelog is
  cosmetic; the client degrades to a "read them on Discord" card instead of
  surfacing a request error. Nothing about the chain depends on this endpoint.
- Title/body splitting and markdown rendering happen **client-side**
  (`src/ui/changelog.ts`), so how notes look can be changed with an ordinary
  frontend deploy without touching this Function or the Pages repo.

## Writing patch notes

No format is required — any message in the channel shows up. Two conventions
make it read better on the site:

- **First line = the title.** A `# Heading` or a `**bold line**` is always
  treated as one; a plain first line is used as the title if it's under 120
  characters, otherwise the entry just shows the date.
- Everything Discord renders works: `**bold**`, `*italic*`, `__underline__`,
  `~~strike~~`, `` `code` ``, ``` code fences ```, `- bullets`, `1.` lists,
  `> quotes`, `[links](https://…)`, and `#`/`##`/`###` headings.

Custom emoji render as `:name:`, and user/channel mentions become plain
`@mention` / `#channel` text, since the site can't resolve Discord IDs.
