import { createHash } from "node:crypto";
import { Input, Telegraf, Telegram, TelegramError } from "telegraf";
import type { User } from "telegraf/types";
import { messages, pickLang } from "./messages";
import {
  extractTikTokUrl,
  ParsedVideo,
  TikTokParser,
  VideoUnavailableError,
} from "./tiktok";

// Telegram fetches this itself, so it must NOT be behind bot protection
// (unlike TikTok's CDN). Shown until the real video replaces it.
const PLACEHOLDER_IMG =
  "https://placehold.co/720x1280/0f0f0f/ffffff.png?text=Loading...";

interface CacheEntry {
  fileId: string;
  title: string;
  caption: string;
}

// video url / video id -> uploaded telegram file_id
const cache = new Map<string, CacheEntry>();

function resultId(url: string): string {
  return createHash("sha1").update(url).digest("hex").slice(0, 32);
}

function buildCacheEntry(video: ParsedVideo, fileId: string): CacheEntry {
  const desc = video.description.trim();
  const author = video.author ? `@${video.author}` : "";
  return {
    fileId,
    title: desc.slice(0, 60) || `TikTok ${author}`.trim(),
    caption: [desc, author && `👤 ${author}`]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 1024),
  };
}

export function setupBot(bot: Telegraf, parser: TikTokParser): void {
  bot.start(async (ctx) => {
    const m = messages[pickLang(ctx.from.language_code)];
    await ctx.reply(m.start(ctx.botInfo.username));
  });

  bot.on("inline_query", async (ctx) => {
    const m = messages[pickLang(ctx.from.language_code)];
    const url = extractTikTokUrl(ctx.inlineQuery.query);

    if (!url) {
      await ctx.answerInlineQuery(
        [
          {
            type: "article",
            id: "help",
            title: m.helpTitle,
            description: m.helpDescription,
            input_message_content: { message_text: m.helpText },
          },
        ],
        { cache_time: 30 },
      );
      return;
    }

    // Already parsed before: answer instantly with the uploaded video.
    const cached = cache.get(url);
    if (cached) {
      await ctx.answerInlineQuery(
        [
          {
            type: "video",
            id: resultId(url),
            video_file_id: cached.fileId,
            title: cached.title,
            caption: cached.caption,
          },
        ],
        { cache_time: 0 },
      );
      return;
    }

    // Parsing takes seconds while inline queries time out fast, so answer
    // with a placeholder right away; the real work happens once the user
    // actually picks the result (chosen_inline_result below). The inline
    // keyboard is required -- without it Telegram omits inline_message_id
    // and the message could never be edited.
    await ctx.answerInlineQuery(
      [
        {
          type: "photo",
          id: resultId(url),
          photo_url: PLACEHOLDER_IMG,
          thumbnail_url: PLACEHOLDER_IMG,
          photo_width: 720,
          photo_height: 1280,
          title: m.loadingTitle,
          caption: m.loadingCaption,
          reply_markup: {
            inline_keyboard: [[{ text: m.openInTikTok, url }]],
          },
        },
      ],
      { cache_time: 0 },
    );
  });

  bot.on("chosen_inline_result", (ctx) => {
    const { inline_message_id, query, from } = ctx.chosenInlineResult;
    // No inline_message_id means a cached-video result was sent -- nothing to edit.
    if (!inline_message_id) return;
    const url = extractTikTokUrl(query);
    if (!url) return;

    // Fire and forget: a 10-20s parse must not block other updates.
    void deliverVideo(
      ctx.telegram,
      parser,
      url,
      inline_message_id,
      from,
      ctx.botInfo.username,
    );
  });
}

async function deliverVideo(
  telegram: Telegram,
  parser: TikTokParser,
  url: string,
  inlineMessageId: string,
  from: User,
  botUsername: string,
): Promise<void> {
  const m = messages[pickLang(from.language_code)];

  try {
    let entry = cache.get(url);

    if (!entry) {
      const video = await parser.parse(url);
      // the same video may already be cached under another link form
      entry = cache.get(video.id);

      if (!entry) {
        // Upload to the requesting user's DM to obtain a reusable file_id
        // (inline messages can't receive freshly uploaded files directly),
        // then delete the temporary message.
        const sent = await telegram.sendVideo(
          from.id,
          Input.fromBuffer(video.buffer, `tiktok_${video.id}.mp4`),
          {
            width: video.width || undefined,
            height: video.height || undefined,
            duration: video.duration || undefined,
            supports_streaming: true,
            disable_notification: true,
          },
        );
        await telegram
          .deleteMessage(from.id, sent.message_id)
          .catch(() => {});
        entry = buildCacheEntry(video, sent.video.file_id);
      }

      cache.set(url, entry);
      cache.set(video.id, entry);
    }

    await telegram.editMessageMedia(undefined, undefined, inlineMessageId, {
      type: "video",
      media: entry.fileId,
      caption: entry.caption,
    });
  } catch (err) {
    console.error(`[bot] failed to deliver ${url}:`, err);
    let text = m.errorParse;
    if (err instanceof VideoUnavailableError) {
      text = m.errorUnavailable;
    } else if (err instanceof TelegramError && err.code === 403) {
      // bot can't message the user (never started / blocked)
      text = m.errorNeedStart(botUsername);
    }
    // the placeholder is a photo message, so update its caption
    await telegram
      .editMessageCaption(undefined, undefined, inlineMessageId, text)
      .catch(() => {});
  }
}
