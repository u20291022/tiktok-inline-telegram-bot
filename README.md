English version · [Русская версия](README.ru.md)

# TikTok Download — inline Telegram bot

The bot downloads a TikTok video from a link and drops it straight into any chat via Telegram's **inline mode** — no need to add the bot to a chat or message it directly.

## How to use it

1. In any chat (private, group, channel — anywhere), start typing `@toksendbot` followed by a TikTok link.
2. A "Send TikTok video" suggestion pops up — tap it.
3. Within a few seconds the placeholder message turns into the actual video, with its caption and author.

Photo-post (slideshow) links work the same way — the bot stitches the images and background music into a short video automatically before sending it.

Supported links:
- `vt.tiktok.com/...`
- `vm.tiktok.com/...`
- `tiktok.com/@user/video/...`
- `tiktok.com/@user/photo/...`
- `tiktok.com/t/...`

<p align="center">
  <img src="assets/inline-query-popup.png" width="320" alt="Typing a link in inline mode"><br>
  <sub>Type <code>@toksendbot &lt;link&gt;</code> in any chat and tap the suggestion</sub>
</p>

<p align="center">
  <img src="assets/video-delivered.jpg" width="320" alt="Video delivered in chat"><br>
  <sub>The video lands in the chat with its caption and author</sub>
</p>

Direct messages to the bot aren't supported — `/start` immediately explains that and shows an example.

<p align="center">
  <img src="assets/bot-profile-start.jpg" width="320" alt="Bot welcome screen"><br>
  <sub>The bot's welcome screen</sub>
</p>

<p align="center">
  <img src="assets/bot-start-reply.png" width="320" alt="Bot's /start reply"><br>
  <sub>What <code>/start</code> replies with</sub>
</p>

---

## How it works

- **`src/index.ts`** — entry point: loads `.env`, creates the bot and the parser, starts polling or webhook mode, and shuts down cleanly on `SIGINT`/`SIGTERM`.
- **`src/bot/`** — all the Telegram logic, split by concern: `index.ts` wires up the `inline_query`/`chosen_inline_result` handlers, `cache.ts` holds the in-memory URL/video-id → Telegram `file_id` cache and caption building, and `deliver.ts` does the actual parse-then-upload-then-edit flow. `inline_query` answers instantly with a placeholder (Telegram inline queries must be answered fast, while parsing a video takes seconds) and also speculatively starts parsing in the background right away, so it's often already done by the time the user taps the result. `chosen_inline_result` fires once a result is actually picked and edits that placeholder into the finished video. Already-downloaded videos are cached by URL and by video id, so repeated requests answer instantly by reusing the Telegram `file_id`.
- **`src/tiktok/`** — the TikTok parser, split by concern: `browser.ts` owns the **Puppeteer** (`puppeteer-extra` + `puppeteer-extra-plugin-stealth`) browser pool, the one-time homepage warm-up, and the randomized jitter between requests; `urls.ts` matches TikTok links, including photo-post URLs; `video.ts` navigates the page, tells a WAF challenge apart from a genuinely missing video, and matches captured `video/mp4` responses against the URLs in the parsed item's `video` object (`playAddr`, `downloadAddr`, `bitrateInfo`) before accepting one, since the page can fire other `video/mp4` responses that aren't the actual video; `types.ts` holds the shared `ParsedVideo` type and tuning constants. A plain `fetch`/`curl` gets a 403 from TikTok's protection (Akamai/Slardar fingerprints the TLS/HTTP2 handshake and serves a JS challenge), so the video page is loaded in a real headless Chromium instance instead, with metadata read from the JSON embedded in the page HTML (`__UNIVERSAL_DATA_FOR_REHYDRATION__`). A finished parse stays reusable for 45 seconds, so the speculative parse from `bot/index.ts` and the later `chosen_inline_result` call usually collapse into a single browser navigation instead of two. When the embedded JSON is missing, the parser tells apart a WAF challenge (retryable — reported to the user as "try again in a minute") from a genuinely blocked/missing video (reported as "may be private/deleted/region-locked"); see [Hosting location](#hosting-location) below for what the second one usually really means.
- **`src/tiktok/photoPost.ts` + `ffmpeg.ts`** — TikTok photo posts (`tiktok.com/@user/photo/...`) have no video at all, just a slideshow of images with a music track, and no embedded item JSON either — that data instead arrives via a client-side XHR TikTok's own page makes, which `photoPost.ts` waits for. It then downloads each image and the audio track in parallel through the same Chromium-based CDN fetch trick used for videos (retrying once on a transient failure), and `ffmpeg.ts` shells out to **ffmpeg** (and `ffprobe`, to detect the audio codec and skip a re-encode when it's already AAC) to compose them into an actual mp4 — each image is shown for at least 3 seconds, even if that stretches the slideshow past the music track's real length, in which case the audio just loops to cover the gap. A hard timeout on the ffmpeg process guards against an encode hanging forever. The rest of the pipeline (caching, Telegram upload) sees an ordinary video either way.
- **`src/tiktok/timing.ts`** — opt-in, no-op-unless-enabled timing logs (`DEBUG_TIMING=true`) for diagnosing slow or hanging parses: page navigation, image/audio downloads, and the ffmpeg encode each get a `[timing]` line with elapsed ms.
- **`src/messages.ts`** — all bot texts in English and Russian, picked based on the user's Telegram `language_code`. The `tg-emoji` IDs in `EMOJI` are the original bot's personal Telegram Premium emoji picks; forks should swap them for IDs of their own, though nothing breaks if you don't — Telegram just renders the plain-unicode fallback baked into each `emoji()` call instead.

---

## Hosting location

Where you host the bot affects whether TikTok will even hand over the video, independent of anything the stealth plugin does.

In production we hit `itemInfo` coming back empty with `statusCode: 10204` and a `statusMsg` containing `ru_cross_border_block,ru_watch_video` — TikTok enforcing Russia's cross-border data rules. This is decided by the **ASN the server's IP belongs to**, not by the machine's actual location, timezone, or browser locale, and it's a different failure mode from bot detection: no amount of stealth-plugin tuning, warm-up navigation, or jitter fixes it.

The two failures log differently and are easy to tell apart:
- `[tiktok] WAF challenge hit for <url>` + a tiny page (barely more than an empty `<head>`) → Akamai/Slardar **bot detection**. The stealth plugin, warm-up visit, and randomized delays already in `src/tiktok/browser.ts` are the right tools here.
- `[tiktok] no embedded JSON (unknown cause) for <url>` + a full-size page (hundreds of KB, a real `<body>`) → the page loaded normally but the item data came back blocked. This is the **cross-border/compliance block**, and the fix is hosting elsewhere, not more stealth.

If you hit the second one, move the bot off any provider whose IP ranges are known for reselling Russia-based TikTok-circumvention VPN/proxy access — TikTok already treats those ranges as suspect. Mainstream providers (Hetzner, DigitalOcean, Vultr, OVH, etc.) generally read as ordinary hosting rather than VPN exit nodes and don't hit this block.

---

## Installing it yourself

### 1. Requirements
- Node.js version pinned in `.nvmrc` (currently `v24.18.0`)
- pnpm
- Linux/macOS/Windows able to run Chromium (Puppeteer downloads it automatically on install)
- `ffmpeg` on `PATH` — only needed for photo-post (slideshow) links; plain video links work fine without it

### 2. System libraries for Chromium and ffmpeg (Linux only)
Headless Chromium on a bare Linux server (Ubuntu/Debian) needs system libraries that minimal server images usually don't have:

```bash
sudo apt-get update && sudo apt-get install -y \
  ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
  libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 \
  libfontconfig1 libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 \
  libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 libxcb1 \
  libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
  libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release \
  xdg-utils libu2f-udev libvulkan1
```

Photo-post slideshows are composed with **ffmpeg**, which isn't part of that dependency list and installs separately:
```bash
sudo apt-get install -y ffmpeg
```

If the server has no virtual display, run through `xvfb` instead — `package.json` already has a `pnpm xvfb` script for that (needs the `xvfb` package: `sudo apt-get install -y xvfb`).

### 3. Project setup
```bash
pnpm install        # also downloads Chromium for Puppeteer
cp .env.example .env
```

Fill in `.env`:
```
BOT_TOKEN=your-telegram-bot-token
BOT_MODE=polling     # or webhook for production behind nginx
```

| Variable | Required | Meaning |
| --- | --- | --- |
| `BOT_TOKEN` | always | Token from [@BotFather](https://t.me/BotFather) |
| `BOT_MODE` | always | `polling` (default, local/dev) or `webhook` (production behind a reverse proxy) |
| `WEBHOOK_DOMAIN` | `webhook` mode only | Public HTTPS domain Telegram sends updates to, e.g. `https://example.com` |
| `WEBHOOK_PATH` | `webhook` mode only | URL path nginx proxies through to the bot, e.g. `/tg-webhook-path` |
| `WEBHOOK_PORT` | `webhook` mode only | Local port the bot listens on behind the reverse proxy |
| `DEBUG_TIMING` | optional | `true` to log verbose per-step timing (page navigation, downloads, ffmpeg encode) for diagnosing slow parses; default `false` |

### 4. Setting up the bot in BotFather
1. Message [@BotFather](https://t.me/BotFather) → `/newbot`, pick a name and username, grab the token — put it into `BOT_TOKEN`.
2. Turn on inline mode: `/setinline` → select your bot → enter a placeholder text (e.g. "Send TikTok video").
3. **Required:** `/setinlinefeedback` → select your bot → **Enabled** — without this Telegram never sends the bot a `chosen_inline_result` update, so it can't tell when a user actually picked a result to start downloading.
4. (optional) `/setdescription` and `/setabouttext` for the bot's profile card.

### 5. Running
```bash
pnpm dev      # development (tsx watch)
pnpm build && pnpm start   # production
pnpm xvfb     # run through a virtual display, if needed
```

For webhook mode also set `WEBHOOK_DOMAIN`, `WEBHOOK_PATH` and `WEBHOOK_PORT` in `.env` — the bot only binds `127.0.0.1`; something like nginx needs to reverse-proxy it over HTTPS.

---

## Troubleshooting

If the bot can't fetch videos, `src/tiktok/video.ts`'s console output points at one of these causes:

1. **Bot detection (WAF challenge)** — `[tiktok] WAF challenge hit for <url>` with a tiny captured page. The user sees a retryable "try again in a minute" error, not "video unavailable" — the parser tells the two apart, so if a definitely-public video comes back as "unavailable," this isn't the cause; see #2 below. See [Hosting location](#hosting-location) — this is the case the stealth plugin, warm-up visit, and jitter are meant to handle; if it happens constantly, check that the Chromium build actually has the stealth patches applied (not a bare `puppeteer-core` swap).
2. **Geo/compliance block** — `[tiktok] no embedded JSON (unknown cause) for <url>` with a full-size captured page. The user sees "may be private/deleted/region-locked," but the real cause is the `ru_cross_border_block` issue described in [Hosting location](#hosting-location) — it's about the server's IP/ASN, not the browser, so re-tuning the parser won't help.
3. **Network/DNS hangs** — every navigation times out at `NAV_TIMEOUT_MS` (30s), including the warm-up visit to `tiktok.com/`, and other sites are just as slow or unreachable from the same host. This isn't TikTok-specific — it's usually the host's DNS resolver or routing. Compare `dig tiktok.com` against your configured resolver with `dig @1.1.1.1 tiktok.com`; if 1.1.1.1 answers fine but the configured resolver doesn't, fix DNS on the host rather than the bot.
4. **Photo posts fail while videos work fine** — the error mentions ffmpeg (`ffmpeg is not installed or not on PATH`). Photo-post slideshows need the `ffmpeg` binary on `PATH` (see [Installing it yourself](#installing-it-yourself)); regular video links don't touch ffmpeg at all, so this only shows up once someone sends a `tiktok.com/@user/photo/...` link.

Set `DEBUG_TIMING=true` in `.env` for verbose per-stage timing logs (page navigation, image/audio downloads, ffmpeg encode) when narrowing down a slow or hanging parse.

---

### Contact
Questions and suggestions: Telegram — [@cline_z](https://t.me/cline_z)
