import { createHash } from "node:crypto";
import { Input, Telegraf, Telegram, TelegramError } from "telegraf";
import type { User } from "telegraf/types";
import { escapeHtml, messages, pickLang } from "./messages";
import {
  extractTikTokUrl,
  ParsedVideo,
  TikTokParser,
  VideoUnavailableError,
} from "./tiktok";

interface CacheEntry {
  fileId: string;
  title: string;
  /** HTML-escaped; language-neutral part (description + author) */
  caption: string;
}

// video url / video id -> uploaded telegram file_id + prebuilt caption parts
const cache = new Map<string, CacheEntry>();

// The prefix encodes what kind of message the result sends ("video:" for a
// cached video, "text:" for the text placeholder). Telegram echoes the id
// back in chosen_inline_result, which needs to know the message kind to
// pick the right edit method (editMessageCaption vs editMessageText).
function resultId(kind: "video" | "text", url: string): string {
  return `${kind}:${createHash("sha1").update(url).digest("hex").slice(0, 32)}`;
}

function buildCacheEntry(video: ParsedVideo, fileId: string): CacheEntry {
  // truncate before escaping so an HTML entity is never cut in half
  const desc = video.description.trim().slice(0, 900);
  const author = video.author ? `@${video.author}` : "";
  return {
    fileId,
    title: desc.slice(0, 60) || `TikTok ${author}`.trim(),
    caption: [escapeHtml(desc), author && `👤 <a href="https://www.tiktok.com/${author}">${escapeHtml(author)}</a>`]
      .filter(Boolean)
      .join("\n\n"),
  };
}

function videoCaption(doneCaption: string, entry: CacheEntry): string {
  return [doneCaption, entry.caption].filter(Boolean).join("\n\n");
}

export function setupBot(bot: Telegraf, parser: TikTokParser): void {
  bot.start(async (ctx) => {
    const m = messages[pickLang(ctx.from.language_code)];
    await ctx.reply(m.start(ctx.botInfo.username), { parse_mode: "HTML" });
  });

  bot.on("inline_query", async (ctx) => {
    const m = messages[pickLang(ctx.from.language_code)];
    const url = extractTikTokUrl(ctx.inlineQuery.query);

    if (!url) {
      await ctx.answerInlineQuery(
        [],
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
            id: resultId("video", url),
            video_file_id: cached.fileId,
            title: cached.title,
            caption: videoCaption(m.doneCaption, cached),
            parse_mode: "HTML",
            // Without a reply_markup, Telegram omits inline_message_id and
            // the sent caption's custom emoji never re-render (only
            // edited messages get that). Attach the same button as the
            // placeholder so chosen_inline_result can re-edit it below.
            reply_markup: {
              inline_keyboard: [[{ text: m.openInTikTok, url }]],
            },
          },
        ],
        { cache_time: 0 },
      );
      return;
    }

    // Speculatively start parsing now instead of waiting for the user to
    // pick the result. parser.parse() dedupes concurrent calls to the same
    // URL, so chosen_inline_result's later parse() call reuses this one --
    // this is a head start, so never let a failure here affect the response.
    void parser.parse(url).catch(() => {});

    // Parsing takes seconds while inline queries time out fast, so answer
    // with a placeholder right away; the real work happens once the user
    // actually picks the result (chosen_inline_result below). The inline
    // keyboard is required -- without it Telegram omits inline_message_id
    // and the message could never be edited.
    await ctx.answerInlineQuery(
      [
        {
          type: "article",
          id: resultId("text", url),
          title: m.loadingTitle,
          description: m.inlineLoadingCaption,
          input_message_content: {
            // Sent without custom emoji: inline-sent messages only render
            // them after an edit, so chosen_inline_result re-sends the
            // loading text with emoji right away.
            message_text: m.loadingCaptionWithoutEmoji,
          },
          reply_markup: {
            inline_keyboard: [[{ text: m.openInTikTok, url }]],
          },
        },
      ],
      { cache_time: 0 },
    );
  });

  // Dont forget to enable /setinlinefeedback in BotFather
  // or bot dont get "chosen_inline_result" updates
  bot.on("chosen_inline_result", async (ctx) => {
    const { inline_message_id, result_id, query, from } = ctx.chosenInlineResult;
    // Both result types attach a reply_markup so this is always present;
    // guard anyway since Telegram's typing marks it optional.
    if (!inline_message_id) return;
    const url = extractTikTokUrl(query);
    if (!url) return;

    // What was sent: a video message (cached result) or the text
    // placeholder. Text messages have no caption, so they must be edited
    // via editMessageText -- editMessageCaption is a 400 there.
    const isVideoMessage = result_id.startsWith("video:");

    // Re-send the loading text with its custom emoji (inline-sent messages
    // only render custom emoji after an edit); cosmetic, so failures are
    // fine to ignore.
    const m = messages[pickLang(from.language_code)];
    if (isVideoMessage) {
      await ctx
        .editMessageCaption(m.loadingCaption, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: m.openInTikTok, url }]],
          },
        })
        .catch(() => {});
    } else {
      await ctx
        .editMessageText(m.loadingCaption, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: m.openInTikTok, url }]],
          },
        })
        .catch(() => {});
    }

    // Fire and forget: a 10-20s parse must not block other updates.
    void deliverVideo(
      ctx.telegram,
      parser,
      url,
      inline_message_id,
      from,
      ctx.botInfo.username,
      isVideoMessage,
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
  isVideoMessage: boolean,
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

    // The "Open in TikTok" button rides along in the same edit: a separate
    // editMessageReplyMarkup call could fail after the media edit already
    // succeeded and wrongly send an already-delivered video into the error
    // handler below.
    await telegram.editMessageMedia(
      undefined,
      undefined,
      inlineMessageId,
      {
        type: "video",
        media: entry.fileId,
        caption: videoCaption(m.doneCaption, entry),
        parse_mode: "HTML",
      },
      {
        reply_markup: {
          inline_keyboard: [[{ text: m.openInTikTok, url }]],
        },
      },
    );
  } catch (err) {
    if (
      err instanceof TelegramError &&
      err.description.includes("message is not modified")
    ) {
      // The message already shows exactly this content (e.g. a cached
      // video whose loading edit didn't land) -- that's success, not
      // something to overwrite with an error text.
      return;
    }
    console.error(`[bot] failed to deliver ${url}:`, err);
    let text = m.errorParse;
    if (err instanceof VideoUnavailableError) {
      text = m.errorUnavailable;
    } else if (err instanceof TelegramError && err.code === 403) {
      // bot can't message the user (never started / blocked)
      text = m.errorNeedStart(botUsername);
    }
    // The media edit is the last step above, so on error the message is
    // still whatever was originally sent: a video (cached result) with a
    // caption to edit, or the plain text placeholder.
    if (isVideoMessage) {
      await telegram
        .editMessageCaption(undefined, undefined, inlineMessageId, text, {
          parse_mode: "HTML",
        })
        .catch(() => {});
    } else {
      await telegram
        .editMessageText(undefined, undefined, inlineMessageId, text, {
          parse_mode: "HTML",
        })
        .catch(() => {});
    }
  }
}
