import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Browser, HTTPResponse, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

const execFileAsync = promisify(execFile);

// TikTok's CDN sits behind Akamai bot detection that fingerprints the
// TLS/HTTP2 handshake, so the video must be captured through a real
// Chromium instance -- plain fetch()/curl gets a 403 there.
//
// TikTok's WAF (Slardar) additionally serves a JS challenge shell for
// video-detail URLs, so the stealth plugin patches navigator.webdriver
// and other automation fingerprints to get past it.
puppeteer.use(StealthPlugin());

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

const POOL_SIZE = 2; // max videos parsed in parallel; the rest queue up
const NAV_TIMEOUT_MS = 30_000;
const VIDEO_WAIT_MS = 20_000;
// Photo posts fetch their item data client-side after the page loads, so the
// script-tag miss must wait a bit for that XHR before giving up.
const API_ITEM_WAIT_MS = 15_000;
// Max side (px) the composed photo-post slideshow is scaled to.
const PHOTO_POST_MAX_SIDE = 1080;
// Per-image display time (s) when a photo post has no usable music duration.
const PHOTO_POST_FALLBACK_SECONDS_PER_IMAGE = 3;
// How long a finished parse stays reusable, so a chosen_inline_result that
// arrives after the speculative parse already resolved doesn't re-parse.
const RESULT_TTL_MS = 45_000;

/** Random delay (ms) so consecutive requests don't look mechanically regular. */
function jitter(minMs = 1000, maxMs = 3000): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((r) => setTimeout(r, ms));
}

const TIKTOK_URL_RE =
  /(?:https?:\/\/)?(?:(?:vt|vm)\.tiktok\.com\/[\w.-]+|(?:www\.)?tiktok\.com\/(?:@[\w.-]+\/(?:video|photo)\/\d+|t\/[\w.-]+))\/?/i;

/** Finds a TikTok link in free-form text; returns a normalized https URL. */
export function extractTikTokUrl(text: string): string | null {
  const match = text.match(TIKTOK_URL_RE);
  if (!match) return null;
  const url = match[0];
  return url.startsWith("http") ? url : `https://${url}`;
}

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

export class TikTokParser {
  private browser: Browser | null = null;
  private freePages: Page[] = [];
  private pagesCreated = 0;
  private waiters: Array<(page: Page) => void> = [];
  private inflight = new Map<string, Promise<ParsedVideo>>();
  private closed = false;
  private warmedUp = false;

  /**
   * Parses and downloads a video; concurrent calls for the same URL share
   * one job, and a resolved job stays reusable for RESULT_TTL_MS so a call
   * shortly after completion (speculative parse finished before the user
   * picked the result) returns instantly instead of re-parsing.
   */
  parse(url: string): Promise<ParsedVideo> {
    const existing = this.inflight.get(url);
    if (existing) return existing;

    const job = this.doParse(url);
    this.inflight.set(url, job);
    job.then(
      // failures are dropped right away so the next attempt can retry
      () => setTimeout(() => this.inflight.delete(url), RESULT_TTL_MS),
      () => this.inflight.delete(url),
    );
    return job;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.closed) throw new Error("Parser is shut down");
    if (!this.browser || !this.browser.connected) {
      this.browser = await puppeteer.launch({
        headless: true,
        // Persist cookies/localStorage across restarts so the browser
        // accumulates session history like a real returning visitor.
        userDataDir: "./puppeteer-profile",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      });
      this.freePages = [];
      this.pagesCreated = 0;
      this.warmedUp = false;
    }
    return this.browser;
  }

  private async acquirePage(): Promise<Page> {
    const browser = await this.getBrowser();
    const free = this.freePages.pop();
    if (free && !free.isClosed()) return free;
    if (this.pagesCreated < POOL_SIZE) {
      this.pagesCreated++;
      const page = await browser.newPage();
      await page.setUserAgent(UA);
      await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
      await page.setViewport({ width: 1280, height: 800 });
      return page;
    }
    return new Promise<Page>((resolve) => this.waiters.push(resolve));
  }

  private releasePage(page: Page): void {
    if (page.isClosed() || !this.browser?.connected) {
      this.pagesCreated--;
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(page);
    else this.freePages.push(page);
  }

  private async doParse(url: string): Promise<ParsedVideo> {
    const page = await this.acquirePage();
    // The detail page prefetches recommended/autoplay videos in the
    // background, so several video/mp4 responses may arrive. Key each by its
    // URL and pick the one that matches this video's own metadata later.
    const capturedByUrl = new Map<string, Buffer>();

    // Photo posts carry no item data in the embedded script tag; it's
    // fetched client-side instead, so capture that response as a fallback.
    let apiItemCaptured = false;
    let apiItem: unknown = null;

    const onResponse = async (res: HTTPResponse) => {
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
        return;
      }
      if (
        !apiItemCaptured &&
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

    try {
      // Once per browser lifetime, warm up the session with a real
      // homepage visit so the first video navigation carries some
      // browsing history instead of going in cold.
      if (!this.warmedUp) {
        await page.goto("https://www.tiktok.com/", {
          waitUntil: "domcontentloaded",
          timeout: NAV_TIMEOUT_MS,
        });
        await jitter(1500, 3000);
        this.warmedUp = true;
        console.warn("[tiktok] warm-up navigation done");
      }

      page.on("response", onResponse);
      await jitter();
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
        // Look like a visitor who arrived from tiktok.com rather than
        // someone pasting a video URL cold.
        referer: "https://www.tiktok.com/",
      });

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
        // arrives via a client-side XHR captured by onResponse above, which
        // may not have landed yet, so give it a moment before giving up.
        const apiDeadline = Date.now() + API_ITEM_WAIT_MS;
        while (!apiItem && Date.now() < apiDeadline) {
          await new Promise((r) => setTimeout(r, 250));
        }
        item = apiItem as typeof item;
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
        return await this.parsePhotoPost(item, page);
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

      return {
        id: String(item.id),
        author: String(item.author?.uniqueId ?? ""),
        description: String(item.desc ?? ""),
        duration: Number(item.video?.duration ?? 0),
        width: Number(item.video?.width ?? 0),
        height: Number(item.video?.height ?? 0),
        buffer: videoBuffer,
      };
    } finally {
      page.off("response", onResponse);
      // stop any still-loading media before the page is reused
      await page.goto("about:blank").catch(() => {});
      this.releasePage(page);
    }
  }

  /**
   * Photo posts have no video track: download each slide image plus the
   * background track, then compose them into an actual mp4 with ffmpeg so
   * downstream code (caching, Telegram upload) sees an ordinary ParsedVideo.
   */
  private async parsePhotoPost(item: any, page: Page): Promise<ParsedVideo> {
    const images: Array<{
      imageWidth: number;
      imageHeight: number;
      imageURL?: { urlList?: string[] };
    }> = item.imagePost.images;

    const imageFiles: Array<{ buffer: Buffer; contentType: string }> = [];
    for (const image of images) {
      imageFiles.push(await this.downloadImageWithRetry(page, image));
    }

    const audioUrl = String(item.music?.playUrl ?? "");
    if (!audioUrl) {
      throw new Error("Photo post is missing item.music.playUrl");
    }
    // TikTok serves some music tracks through the same video CDN infra used
    // for videos, tagged Content-Type: video/mp4 despite carrying no video
    // stream, so both content-types are accepted here.
    const audioFile = await this.downloadMedia(page, audioUrl, [
      "audio/",
      "video/mp4",
    ]);

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

    const buffer = await this.composePhotoPostVideo(
      imageFiles,
      audioFile,
      perImageSeconds,
      width,
      height,
    );

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
  private async downloadImageWithRetry(
    page: Page,
    image: { imageURL?: { urlList?: string[] } },
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const urls = image.imageURL?.urlList ?? [];
    if (urls.length === 0) throw new Error("Photo post image has no urlList");
    try {
      return await this.downloadMedia(page, urls[0], ["image/"]);
    } catch (err) {
      if (!urls[1]) throw err;
      return await this.downloadMedia(page, urls[1], ["image/"]);
    }
  }

  /**
   * Navigates the page directly to a media URL and captures the response
   * body, the same Chromium-in-the-loop trick doParse uses for video/mp4 --
   * these CDN URLs sit behind the same Akamai TLS fingerprinting.
   */
  private async downloadMedia(
    page: Page,
    url: string,
    contentTypePrefixes: string[],
  ): Promise<{ buffer: Buffer; contentType: string }> {
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
      throw new Error(
        `Failed to download media (${contentTypePrefixes.join("/")}) from ${url}`,
      );
    }
    return result;
  }

  /**
   * Writes the downloaded slide images and audio to a temp dir and shells
   * out to ffmpeg's concat demuxer to combine them into a single mp4.
   */
  private async composePhotoPostVideo(
    imageFiles: Array<{ buffer: Buffer; contentType: string }>,
    audioFile: { buffer: Buffer; contentType: string },
    perImageSeconds: number,
    width: number,
    height: number,
  ): Promise<Buffer> {
    const workDir = await mkdtemp(join(tmpdir(), "tiktok-photopost-"));
    try {
      const imagePaths = await Promise.all(
        imageFiles.map(async ({ buffer, contentType }, i) => {
          const path = join(
            workDir,
            `img${String(i).padStart(3, "0")}${extensionFor(contentType, ".jpg")}`,
          );
          await writeFile(path, buffer);
          return path;
        }),
      );
      const audioPath = join(
        workDir,
        `audio${extensionFor(audioFile.contentType, ".m4a")}`,
      );
      await writeFile(audioPath, audioFile.buffer);

      // The concat demuxer ignores the last entry's duration, so the final
      // image is repeated once more to make its display time take effect.
      const listLines: string[] = [];
      for (const path of imagePaths) {
        listLines.push(`file '${toFfmpegConcatPath(path)}'`);
        listLines.push(`duration ${perImageSeconds.toFixed(3)}`);
      }
      listLines.push(
        `file '${toFfmpegConcatPath(imagePaths[imagePaths.length - 1])}'`,
      );
      const listPath = join(workDir, "list.txt");
      await writeFile(listPath, listLines.join("\n"));

      const outputPath = join(workDir, "output.mp4");
      await this.runFfmpeg([
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-i",
        audioPath,
        "-vf",
        `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-shortest",
        outputPath,
      ]);

      return await readFile(outputPath);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async runFfmpeg(args: string[]): Promise<void> {
    try {
      await execFileAsync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 64 });
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        throw new Error(
          "ffmpeg is not installed or not on PATH -- required to compose photo-post slideshows",
        );
      }
      throw new Error(`ffmpeg failed to compose photo post: ${err?.stderr ?? err?.message ?? err}`);
    }
  }
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

const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/aac": ".aac",
};

function extensionFor(contentType: string, fallback: string): string {
  for (const [key, ext] of Object.entries(EXTENSION_BY_CONTENT_TYPE)) {
    if (contentType.startsWith(key)) return ext;
  }
  return fallback;
}

/** Normalizes a filesystem path for use in an ffmpeg concat list entry. */
function toFfmpegConcatPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/'/g, "'\\''");
}
