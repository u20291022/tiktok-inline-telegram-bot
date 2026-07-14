export type Lang = "en" | "ru";

export function pickLang(languageCode?: string): Lang {
  return languageCode?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

/** All outgoing texts use HTML parse mode; escape anything user-generated. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const EMOJI = {
  wave: "5967683261940372267",
  loading: "5967726903103067244",
  success: "5969721610469380841",
  error: "5967619945532494648",
} as const;

function emoji(id: (typeof EMOJI)[keyof typeof EMOJI], fallback: string): string {
  return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
}

export const messages: Record<
  Lang,
  {
    start: (botUsername: string) => string;
    loadingTitle: string;
    loadingCaption: string;
    inlineLoadingCaption: string,
    loadingCaptionWithoutEmoji: string,
    doneCaption: string;
    openInTikTok: string;
    errorUnavailable: string;
    errorParse: string;
    errorNeedStart: (botUsername: string) => string;
  }
> = {
  en: {
    start: (botUsername) =>
      `${emoji(EMOJI.wave, "👋")} This bot works in inline mode only — it cannot send videos here in direct messages.\n\n` +
      `In any chat, type:\n@${botUsername} &lt;TikTok link&gt;\n\n` +
      "…then tap the result to send the video.\n\n" +
      "Supported links:\n" +
      "• vt.tiktok.com/…\n" +
      "• vm.tiktok.com/…\n" +
      "• tiktok.com/@user/video/…\n" +
      "• tiktok.com/t/…",
    loadingTitle: "Send TikTok video",
    loadingCaption: `${emoji(EMOJI.loading, "🥳")} Loading video, it will appear here in a few seconds…`,
    inlineLoadingCaption: `Tap here to start loading your video!`,
    loadingCaptionWithoutEmoji: `Loading video, it will appear here in a few seconds…`,
    doneCaption: `${emoji(EMOJI.success, "🙌")} Here's your video!`,
    openInTikTok: "Open in TikTok",
    errorUnavailable: `${emoji(EMOJI.error, "❌")} Couldn't get this video. It may be private, deleted or region-locked.`,
    errorParse: `${emoji(EMOJI.error, "❌")} Failed to download this video. Please try again in a minute.`,
    errorNeedStart: (botUsername) =>
      `${emoji(EMOJI.error, "❌")} I need you to start me first so I can process videos.\nOpen @${botUsername}, press Start, then send the link again.`,
  },
  ru: {
    start: (botUsername) =>
      `${emoji(EMOJI.wave, "👋")} Этот бот работает только в инлайн-режиме — он не может отправлять видео здесь, в личных сообщениях.\n\n` +
      `В любом чате наберите:\n@${botUsername} &lt;ссылка на TikTok&gt;\n\n` +
      "…и нажмите на результат, чтобы отправить видео.\n\n" +
      "Поддерживаемые ссылки:\n" +
      "• vt.tiktok.com/…\n" +
      "• vm.tiktok.com/…\n" +
      "• tiktok.com/@user/video/…\n" +
      "• tiktok.com/t/…",
    loadingTitle: "Отправить видео из TikTok",
    loadingCaption: `${emoji(EMOJI.loading, "🥳")} Загружаю видео, оно появится здесь через несколько секунд…`,
    inlineLoadingCaption: `Нажмите сюда, чтобы загрузить видео!`,
    loadingCaptionWithoutEmoji: `Загружаю видео, оно появится здесь через несколько секунд…`,
    doneCaption: `${emoji(EMOJI.success, "🙌")} Ваше видео готово!`,
    openInTikTok: "Открыть в TikTok",
    errorUnavailable: `${emoji(EMOJI.error, "❌")} Не удалось получить это видео. Возможно, оно приватное, удалено или недоступно в регионе.`,
    errorParse: `${emoji(EMOJI.error, "❌")} Не удалось скачать это видео. Попробуйте ещё раз через минуту.`,
    errorNeedStart: (botUsername) =>
      `${emoji(EMOJI.error, "❌")} Сначала запустите бота, чтобы я мог обработать видео.\nОткройте @${botUsername}, нажмите Start и отправьте ссылку ещё раз.`,
  },
};
