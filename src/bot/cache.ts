import { createHash } from "node:crypto";
import type { User } from "telegraf/types";
import { escapeHtml } from "../messages";
import { ParsedVideo } from "../tiktok";

export interface CacheEntry {
  fileId: string;
  title: string;
  /** HTML-escaped; language-neutral part (description + author) */
  caption: string;
}

// video url / video id -> uploaded telegram file_id + prebuilt caption parts
export const cache = new Map<string, CacheEntry>();

export interface RetryContext {
  url: string;
  isVideoMessage: boolean;
  from: User;
}

// inline_message_id -> what's needed to retry a failed delivery. Callback
// queries on inline messages only carry inline_message_id (no message
// object), so this is the only way to recover the original url/kind/user.
export const retryContext = new Map<string, RetryContext>();

// The prefix encodes what kind of message the result sends ("video:" for a
// cached video, "text:" for the text placeholder). Telegram echoes the id
// back in chosen_inline_result, which needs to know the message kind to
// pick the right edit method (editMessageCaption vs editMessageText).
export function resultId(kind: "video" | "text", url: string): string {
  return `${kind}:${createHash("sha1").update(url).digest("hex").slice(0, 32)}`;
}

export function buildCacheEntry(video: ParsedVideo, fileId: string): CacheEntry {
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

export function videoCaption(doneCaption: string, entry: CacheEntry): string {
  return [doneCaption, entry.caption].filter(Boolean).join("\n\n");
}
