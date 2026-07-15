const TIKTOK_URL_RE =
  /(?:https?:\/\/)?(?:(?:vt|vm)\.tiktok\.com\/[\w.-]+|(?:www\.)?tiktok\.com\/(?:@[\w.-]+\/(?:video|photo)\/\d+|t\/[\w.-]+))\/?/i;

/** Finds a TikTok link in free-form text; returns a normalized https URL. */
export function extractTikTokUrl(text: string): string | null {
  const match = text.match(TIKTOK_URL_RE);
  if (!match) return null;
  const url = match[0];
  return url.startsWith("http") ? url : `https://${url}`;
}
