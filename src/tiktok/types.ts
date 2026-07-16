export class VideoUnavailableError extends Error {}

export interface ParsedVideo {
  id: string;
  author: string;
  description: string;
  duration: number;
  width: number;
  height: number;
  buffer: Buffer;
}

export const POOL_SIZE = 2; // max videos parsed in parallel; the rest queue up
export const NAV_TIMEOUT_MS = 30_000;
export const VIDEO_WAIT_MS = 20_000;
// Photo posts fetch their item data client-side after the page loads, so the
// script-tag miss must wait a bit for that XHR before giving up.
export const API_ITEM_WAIT_MS = 15_000;
// Max side (px) the composed photo-post slideshow is scaled to.
export const PHOTO_POST_MAX_SIDE = 1080;
// Minimum per-image display time (s) for a photo post -- used both as the
// floor when the music duration split across images would be faster than
// this, and as the flat fallback when there's no usable music duration at
// all.
export const PHOTO_POST_MIN_SECONDS_PER_IMAGE = 3;
// How long a finished parse stays reusable, so a chosen_inline_result that
// arrives after the speculative parse already resolved doesn't re-parse.
export const RESULT_TTL_MS = 45_000;
