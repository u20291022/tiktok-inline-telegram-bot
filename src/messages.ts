export type Lang = "en" | "ru";

export function pickLang(languageCode?: string): Lang {
  return languageCode?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export const messages: Record<
  Lang,
  {
    start: (botUsername: string) => string;
    helpTitle: string;
    helpDescription: string;
    helpText: string;
    loadingTitle: string;
    loadingCaption: string;
    openInTikTok: string;
    errorUnavailable: string;
    errorParse: string;
    errorNeedStart: (botUsername: string) => string;
  }
> = {
  en: {
    start: (botUsername) =>
      "👋 This bot works in inline mode only — it cannot send videos here in direct messages.\n\n" +
      `In any chat, type:\n@${botUsername} <TikTok link>\n\n` +
      "…then tap the result to send the video.\n\n" +
      "Supported links:\n" +
      "• vt.tiktok.com/…\n" +
      "• vm.tiktok.com/…\n" +
      "• tiktok.com/@user/video/…",
    helpTitle: "Send me a TikTok link",
    helpDescription: "vt.tiktok.com/… • vm.tiktok.com/… • tiktok.com/@user/video/…",
    helpText:
      "To download a TikTok video, type the bot username followed by a TikTok link.",
    loadingTitle: "Send TikTok video",
    loadingCaption: "⏳ Loading video, it will appear here in a few seconds…",
    openInTikTok: "Open in TikTok",
    errorUnavailable:
      "😔 Couldn't get this video. It may be private, deleted or region-locked.",
    errorParse:
      "⚠️ Failed to download this video. Please try again in a minute.",
    errorNeedStart: (botUsername) =>
      `⚠️ I need you to start me first so I can process videos.\nOpen @${botUsername}, press Start, then send the link again.`,
  },
  ru: {
    start: (botUsername) =>
      "👋 Этот бот работает только в инлайн-режиме — он не может отправлять видео здесь, в личных сообщениях.\n\n" +
      `В любом чате наберите:\n@${botUsername} <ссылка на TikTok>\n\n` +
      "…и нажмите на результат, чтобы отправить видео.\n\n" +
      "Поддерживаемые ссылки:\n" +
      "• vt.tiktok.com/…\n" +
      "• vm.tiktok.com/…\n" +
      "• tiktok.com/@user/video/…",
    helpTitle: "Отправьте ссылку на TikTok",
    helpDescription: "vt.tiktok.com/… • vm.tiktok.com/… • tiktok.com/@user/video/…",
    helpText:
      "Чтобы скачать видео из TikTok, введите имя бота и ссылку на видео.",
    loadingTitle: "Отправить видео из TikTok",
    loadingCaption: "⏳ Загружаю видео, оно появится здесь через несколько секунд…",
    openInTikTok: "Открыть в TikTok",
    errorUnavailable:
      "😔 Не удалось получить это видео. Возможно, оно приватное, удалено или недоступно в регионе.",
    errorParse:
      "⚠️ Не удалось скачать это видео. Попробуйте ещё раз через минуту.",
    errorNeedStart: (botUsername) =>
      `⚠️ Сначала запустите бота, чтобы я мог обработать видео.\nОткройте @${botUsername}, нажмите Start и отправьте ссылку ещё раз.`,
  },
};
