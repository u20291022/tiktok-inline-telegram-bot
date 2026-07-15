import { Input, Telegram, TelegramError } from "telegraf";
import type { User } from "telegraf/types";
import { messages, pickLang } from "../messages";
import { TikTokParser, VideoUnavailableError } from "../tiktok";
import { buildCacheEntry, cache, videoCaption } from "./cache";

export async function deliverVideo(
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
