import { Telegraf } from "telegraf";
import { messages, pickLang } from "../messages";
import { extractTikTokUrl, TikTokParser } from "../tiktok";
import { cache, resultId, retryContext, videoCaption } from "./cache";
import { deliverVideo } from "./deliver";

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

  bot.on("callback_query", async (ctx) => {
    const cq = ctx.callbackQuery;
    if (!("data" in cq) || cq.data !== "retry") return;

    const inlineMessageId = cq.inline_message_id;
    const retry = inlineMessageId && retryContext.get(inlineMessageId);
    if (!retry) {
      await ctx.answerCbQuery().catch(() => {});
      return;
    }

    const { url, isVideoMessage, from } = retry;
    const m = messages[pickLang(from.language_code)];
    await ctx.answerCbQuery().catch(() => {});

    // Same loading edit as chosen_inline_result: drop the retry button and
    // go back to the plain "Open in TikTok" markup while re-parsing.
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

    void deliverVideo(
      ctx.telegram,
      parser,
      url,
      inlineMessageId,
      from,
      ctx.botInfo.username,
      isVideoMessage,
    );
  });
}
