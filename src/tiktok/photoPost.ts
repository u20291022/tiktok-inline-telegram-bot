import type { HTTPResponse, Page } from "puppeteer";
import { composePhotoPostVideo } from "./ffmpeg";
import { DEBUG_TIMING, timeLog } from "./timing";
import {
  NAV_TIMEOUT_MS,
  ParsedVideo,
  PHOTO_POST_FALLBACK_SECONDS_PER_IMAGE,
  PHOTO_POST_MAX_SIDE,
} from "./types";

/**
 * Photo posts carry no item data in the embedded script tag; it's fetched
 * client-side instead, so this captures that response as a fallback. The
 * listener must be attached before navigation (the XHR can land early), so
 * registration and waiting are split into two steps here.
 */
export function createApiItemCapture(): {
  onResponse: (res: HTTPResponse) => Promise<void>;
  wait: (waitMs: number) => Promise<unknown>;
} {
  let apiItemCaptured = false;
  let apiItem: unknown = null;

  const onResponse = async (res: HTTPResponse) => {
    if (apiItemCaptured) return;
    const resUrl = res.url();
    const ct = res.headers()["content-type"] || "";
    if (
      resUrl.includes("/api/item/detail/") &&
      resUrl.includes("itemId=") &&
      ct.includes("application/json") &&
      res.status() === 200
    ) {
      apiItemCaptured = true;
      try {
        const json = JSON.parse(await res.text());
        apiItem = json?.itemInfo?.itemStruct ?? null;
      } catch {
        // malformed body -- leave apiItem null, handled like a missing item
      }
    }
  };

  const wait = async (waitMs: number): Promise<unknown> => {
    const apiDeadline = Date.now() + waitMs;
    while (!apiItem && Date.now() < apiDeadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return apiItem;
  };

  return { onResponse, wait };
}

/**
 * Photo posts have no video track: download each slide image plus the
 * background track, then compose them into an actual mp4 with ffmpeg so
 * downstream code (caching, Telegram upload) sees an ordinary ParsedVideo.
 */
export async function parsePhotoPost(item: any, page: Page): Promise<ParsedVideo> {
  const parseStart = Date.now();
  const images: Array<{
    imageWidth: number;
    imageHeight: number;
    imageURL?: { urlList?: string[] };
  }> = item.imagePost.images;

  if (DEBUG_TIMING) {
    const sizes = images
      .map((img) => `${img.imageWidth}x${img.imageHeight}`)
      .join(",");
    console.warn(
      `[timing] photoPost item summary: images=${images.length} sizes=[${sizes}] musicDuration=${item.music?.duration}`,
    );
  }

  const downloadStart = Date.now();
  const imageFiles: Array<{ buffer: Buffer; contentType: string }> = [];
  for (const image of images) {
    imageFiles.push(await downloadImageWithRetry(page, image));
  }

  const audioUrl = String(item.music?.playUrl ?? "");
  if (!audioUrl) {
    throw new Error("Photo post is missing item.music.playUrl");
  }
  // TikTok serves some music tracks through the same video CDN infra used
  // for videos, tagged Content-Type: video/mp4 despite carrying no video
  // stream, so both content-types are accepted here.
  const audioFile = await downloadMedia(page, audioUrl, ["audio/", "video/mp4"]);
  timeLog("photoPost downloads (images+audio)", downloadStart);

  const musicDuration = Number(item.music?.duration ?? 0);
  const perImageSeconds =
    musicDuration > 0
      ? musicDuration / images.length
      : PHOTO_POST_FALLBACK_SECONDS_PER_IMAGE;
  const totalDuration =
    musicDuration > 0
      ? musicDuration
      : images.length * PHOTO_POST_FALLBACK_SECONDS_PER_IMAGE;

  const firstImage = images[0];
  const { width, height } = computeCanvas(
    Number(firstImage.imageWidth),
    Number(firstImage.imageHeight),
    PHOTO_POST_MAX_SIDE,
  );

  const ffmpegStart = Date.now();
  const buffer = await composePhotoPostVideo(
    imageFiles,
    audioFile,
    perImageSeconds,
    width,
    height,
  );
  timeLog("photoPost composePhotoPostVideo (ffmpeg)", ffmpegStart);

  timeLog("parsePhotoPost total", parseStart);
  return {
    id: String(item.id),
    author: String(item.author?.uniqueId ?? ""),
    description: String(item.desc ?? ""),
    duration: totalDuration,
    width,
    height,
    buffer,
  };
}

/** Downloads one photo-post image, retrying with the mirror URL once. */
async function downloadImageWithRetry(
  page: Page,
  image: { imageURL?: { urlList?: string[] } },
): Promise<{ buffer: Buffer; contentType: string }> {
  const urls = image.imageURL?.urlList ?? [];
  if (urls.length === 0) throw new Error("Photo post image has no urlList");
  try {
    return await downloadMedia(page, urls[0], ["image/"]);
  } catch (err) {
    if (!urls[1]) throw err;
    return await downloadMedia(page, urls[1], ["image/"]);
  }
}

/**
 * Navigates the page directly to a media URL and captures the response
 * body, the same Chromium-in-the-loop trick used for video/mp4 captures --
 * these CDN URLs sit behind the same Akamai TLS fingerprinting.
 */
async function downloadMedia(
  page: Page,
  url: string,
  contentTypePrefixes: string[],
): Promise<{ buffer: Buffer; contentType: string }> {
  const start = Date.now();
  let result: { buffer: Buffer; contentType: string } | null = null;
  const onResponse = async (res: HTTPResponse) => {
    if (result) return;
    // The page keeps loading unrelated background responses (favicons,
    // TikTok's own logo/icon assets, other queued thumbnails) while we
    // wait, and those can share a content-type prefix with what we asked
    // for -- so the response must also match the exact URL we requested.
    if (res.url() !== url) return;
    const ct = res.headers()["content-type"] || "";
    if (
      res.status() === 200 &&
      contentTypePrefixes.some((p) => ct.startsWith(p))
    ) {
      try {
        result = { buffer: Buffer.from(await res.buffer()), contentType: ct };
      } catch {
        // body already gone -- the deadline below will surface the failure
      }
    }
  };

  page.on("response", onResponse);
  try {
    // A top-level page.goto to a media URL makes Chrome treat it as a
    // file download (ERR_ABORTED) instead of a navigable response, so the
    // request is issued in-page instead; CDP still exposes the raw body
    // via response.buffer() regardless of the page's own CORS visibility.
    await page.evaluate((u) => {
      fetch(u, { mode: "no-cors", credentials: "omit" }).catch(() => {});
    }, url);
    const deadline = Date.now() + NAV_TIMEOUT_MS;
    while (!result && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    page.off("response", onResponse);
  }

  if (!result) {
    timeLog(`downloadMedia FAILED url=${url}`, start);
    throw new Error(
      `Failed to download media (${contentTypePrefixes.join("/")}) from ${url}`,
    );
  }
  timeLog(`downloadMedia OK url=${url}`, start);
  return result;
}

/** Fits width/height within a maxSide x maxSide box, rounded to even pixels. */
function computeCanvas(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const toEven = (n: number) => {
    const r = Math.round(n);
    return r % 2 === 0 ? r : r + 1;
  };
  return { width: toEven(width * scale), height: toEven(height * scale) };
}
