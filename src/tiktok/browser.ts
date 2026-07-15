import type { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { NAV_TIMEOUT_MS, POOL_SIZE } from "./types";

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

/** Random delay (ms) so consecutive requests don't look mechanically regular. */
export function jitter(minMs = 1000, maxMs = 3000): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((r) => setTimeout(r, ms));
}

export class BrowserPool {
  private browser: Browser | null = null;
  private freePages: Page[] = [];
  private pagesCreated = 0;
  private waiters: Array<(page: Page) => void> = [];
  private closed = false;
  private warmedUp = false;

  async getBrowser(): Promise<Browser> {
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

  async acquirePage(): Promise<Page> {
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

  releasePage(page: Page): void {
    if (page.isClosed() || !this.browser?.connected) {
      this.pagesCreated--;
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) waiter(page);
    else this.freePages.push(page);
  }

  /**
   * Once per browser lifetime, warms up the session with a real homepage
   * visit so the first video navigation carries some browsing history
   * instead of going in cold.
   */
  async ensureWarmedUp(page: Page): Promise<void> {
    if (this.warmedUp) return;
    await page.goto("https://www.tiktok.com/", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    await jitter(1500, 3000);
    this.warmedUp = true;
    console.warn("[tiktok] warm-up navigation done");
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}
