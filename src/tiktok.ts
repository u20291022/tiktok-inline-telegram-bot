import type { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

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

/** Random delay (ms) so consecutive requests don't look mechanically regular. */
function jitter(minMs = 1000, maxMs = 3000): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((r) => setTimeout(r, ms));
}

const TIKTOK_URL_RE =
  /(?:https?:\/\/)?(?:(?:vt|vm)\.tiktok\.com\/[\w.-]+|(?:www\.)?tiktok\.com\/@[\w.-]+\/video\/\d+)\/?/i;

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

  /** Parses and downloads a video; concurrent calls for the same URL share one job. */
  parse(url: string): Promise<ParsedVideo> {
    const existing = this.inflight.get(url);
    if (existing) return existing;

    const job = this.doParse(url).finally(() => this.inflight.delete(url));
    this.inflight.set(url, job);
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
    let videoBuffer: Buffer | null = null;

    const onResponse = async (res: import("puppeteer").HTTPResponse) => {
      const ct = res.headers()["content-type"] || "";
      if (ct.includes("video/mp4") && res.status() === 200 && !videoBuffer) {
        try {
          videoBuffer = Buffer.from(await res.buffer());
        } catch {
          // body already gone (duplicate/aborted request) -- ignore
        }
      }
    };

    try {
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
      const item = await page.evaluate(() => {
        const script = document.getElementById(
          "__UNIVERSAL_DATA_FOR_REHYDRATION__",
        );
        if (!script) return null;
        const data = JSON.parse(script.textContent!);
        return data.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo
          ?.itemStruct ?? null;
      });

      if (!item) {
        // Distinguish a WAF (Slardar) JS challenge from a genuinely
        // missing video, for monitoring. The challenge shell is
        // <html><head>...</head></html> with no real <body>, whereas a
        // real video page is 300-500KB+. (Don't match "slardar" -- that
        // SDK ships on legitimate pages too and gives false positives.)
        const html = await page.content();
        if (!html.includes("<body") || html.length < 5000) {
          console.warn(`[tiktok] WAF challenge hit for ${url}`);
        } else {
          console.warn(`[tiktok] no embedded JSON (unknown cause) for ${url}`);
        }
        throw new VideoUnavailableError(
          "No embedded video JSON -- video may be private/deleted/region-locked",
        );
      }

      // wait for the video response to be captured
      const deadline = Date.now() + VIDEO_WAIT_MS;
      while (!videoBuffer && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
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
}
