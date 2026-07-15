import { BrowserPool } from "./browser";
import { ParsedVideo, RESULT_TTL_MS } from "./types";
import { doParse } from "./video";

export { extractTikTokUrl } from "./urls";
export { ParsedVideo, VideoUnavailableError } from "./types";

export class TikTokParser {
  private pool = new BrowserPool();
  private inflight = new Map<string, Promise<ParsedVideo>>();

  /**
   * Parses and downloads a video; concurrent calls for the same URL share
   * one job, and a resolved job stays reusable for RESULT_TTL_MS so a call
   * shortly after completion (speculative parse finished before the user
   * picked the result) returns instantly instead of re-parsing.
   */
  parse(url: string): Promise<ParsedVideo> {
    const existing = this.inflight.get(url);
    if (existing) return existing;

    const job = doParse(this.pool, url);
    this.inflight.set(url, job);
    job.then(
      // failures are dropped right away so the next attempt can retry
      () => setTimeout(() => this.inflight.delete(url), RESULT_TTL_MS),
      () => this.inflight.delete(url),
    );
    return job;
  }

  async close(): Promise<void> {
    await this.pool.close();
  }
}
