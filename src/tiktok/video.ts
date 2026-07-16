import type { HTTPResponse } from "puppeteer";
import { BrowserPool, jitter } from "./browser";
import { createApiItemCapture, parsePhotoPost } from "./photoPost";
import { timeLog } from "./timing";
import {
  API_ITEM_WAIT_MS,
  NAV_TIMEOUT_MS,
  ParsedVideo,
  VIDEO_WAIT_MS,
  VideoUnavailableError,
} from "./types";

export async function doParse(pool: BrowserPool, url: string): Promise<ParsedVideo> {
  const jobStart = Date.now();
  const page = await pool.acquirePage();
  // The detail page prefetches recommended/autoplay videos in the
  // background, so several video/mp4 responses may arrive. Key each by its
  // URL and pick the one that matches this video's own metadata later.
  const capturedByUrl = new Map<string, Buffer>();

  const apiItemCapture = createApiItemCapture();

  const onVideoResponse = async (res: HTTPResponse) => {
    const ct = res.headers()["content-type"] || "";
    const resUrl = res.url();
    if (
      ct.includes("video/mp4") &&
      res.status() === 200 &&
      !capturedByUrl.has(resUrl)
    ) {
      try {
        capturedByUrl.set(resUrl, Buffer.from(await res.buffer()));
      } catch {
        // body already gone (duplicate/aborted request) -- ignore
      }
    }
  };

  try {
    await pool.ensureWarmedUp(page);

    page.on("response", onVideoResponse);
    page.on("response", apiItemCapture.onResponse);
    await jitter();
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
      // Look like a visitor who arrived from tiktok.com rather than
      // someone pasting a video URL cold.
      referer: "https://www.tiktok.com/",
    });
    timeLog("page.goto resolved", jobStart);

    // Metadata is embedded in the page HTML regardless of the video request
    let item = await page.evaluate(() => {
      const script = document.getElementById(
        "__UNIVERSAL_DATA_FOR_REHYDRATION__",
      );
      if (!script) return null;
      const data = JSON.parse(script.textContent!);
      return data.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo
        ?.itemStruct ?? null;
    });

    if (!item) {
      // Photo posts have no embedded item JSON -- their data instead
      // arrives via a client-side XHR captured by apiItemCapture above,
      // which may not have landed yet, so give it a moment before giving up.
      item = (await apiItemCapture.wait(API_ITEM_WAIT_MS)) as typeof item;
      timeLog(
        `api-item-capture wait resolved (source: xhr-fallback, found: ${Boolean(item)})`,
        jobStart,
      );
    }

    if (!item) {
      // Distinguish a WAF (Slardar) JS challenge from a genuinely
      // missing video, for monitoring. The challenge shell is
      // <html><head>...</head></html> with no real <body>, whereas a
      // real video page is 300-500KB+. (Don't match "slardar" -- that
      // SDK ships on legitimate pages too and gives false positives.)
      const html = await page.content();
      if (!html.includes("<body") || html.length < 5000) {
        console.warn(`[tiktok] WAF challenge hit for ${url}`);
        // Bot detection, not a missing video: a plain Error routes to
        // the generic "try again in a minute" message instead of
        // wrongly telling the user the video is private/deleted.
        throw new Error("WAF challenge served instead of the video page");
      }
      console.warn(`[tiktok] no embedded JSON (unknown cause) for ${url}`);
      throw new VideoUnavailableError(
        "No embedded video JSON -- video may be private/deleted/region-locked",
      );
    }

    if (item.imagePost?.images?.length > 0) {
      timeLog("before parsePhotoPost", jobStart);
      const photoPostStart = Date.now();
      const result = await parsePhotoPost(item, page);
      timeLog("parsePhotoPost returned (total)", photoPostStart);
      timeLog("doParse total", jobStart);
      return result;
    }

    // The CDN URLs this video is actually served from, per its own metadata.
    // A captured response only counts if its URL is one of these, otherwise
    // it belongs to a prefetched recommendation, not the requested video.
    const knownUrls = new Set<string>();
    if (item.video?.playAddr) knownUrls.add(String(item.video.playAddr));
    if (item.video?.downloadAddr)
      knownUrls.add(String(item.video.downloadAddr));
    for (const info of item.video?.bitrateInfo ?? []) {
      for (const u of info?.PlayAddr?.UrlList ?? []) {
        knownUrls.add(String(u));
      }
    }

    const findMatch = (): Buffer | null => {
      for (const u of knownUrls) {
        const buf = capturedByUrl.get(u);
        if (buf) return buf;
      }
      return null;
    };

    // The video response may have arrived before metadata was evaluated, so
    // check immediately, then poll until the deadline.
    let videoBuffer = findMatch();
    const deadline = Date.now() + VIDEO_WAIT_MS;
    while (!videoBuffer && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
      videoBuffer = findMatch();
    }
    if (!videoBuffer) {
      throw new Error("Metadata resolved but no video response captured");
    }

    timeLog("doParse total", jobStart);
    return {
      id: String(item.id),
      author: String(item.author?.uniqueId ?? ""),
      description: String(item.desc ?? ""),
      duration: Number(item.video?.duration ?? 0),
      width: Number(item.video?.width ?? 0),
      height: Number(item.video?.height ?? 0),
      buffer: videoBuffer,
    };
  } catch (err) {
    timeLog("doParse total (failed)", jobStart);
    throw err;
  } finally {
    page.off("response", onVideoResponse);
    page.off("response", apiItemCapture.onResponse);
    // stop any still-loading media before the page is reused
    await page.goto("about:blank").catch(() => {});
    pool.releasePage(page);
  }
}
