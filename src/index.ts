import "dotenv/config";
import { Telegraf } from "telegraf";
import { setupBot } from "./bot";
import { TikTokParser } from "./tiktok";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is not set (see .env.example)");
  process.exit(1);
}

const mode = (process.env.BOT_MODE ?? "polling").toLowerCase();

const bot = new Telegraf(token);
const parser = new TikTokParser();
setupBot(bot, parser);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[bot] ${signal} received, shutting down…`);
  try {
    bot.stop(signal);
  } catch {
    // not launched yet
  }
  await parser.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

async function main(): Promise<void> {
  if (mode === "webhook") {
    const domain = process.env.WEBHOOK_DOMAIN;
    const path = process.env.WEBHOOK_PATH;
    const port = Number(process.env.WEBHOOK_PORT);
    if (!domain || !path || !port) {
      throw new Error(
        "webhook mode requires WEBHOOK_DOMAIN, WEBHOOK_PATH and WEBHOOK_PORT (see .env.example)",
      );
    }
    console.log("[bot] mode: webhook");
    console.log(
      `[bot] webhook url: ${domain.replace(/\/$/, "")}${path} -> 127.0.0.1:${port}`,
    );
    // nginx reverse-proxies the public path here, so bind localhost only
    await bot.launch(
      { webhook: { domain, path, host: "127.0.0.1", port } },
      () => console.log(`[bot] webhook registered, @${bot.botInfo?.username} is up`),
    );
  } else {
    console.log("[bot] mode: polling");
    await bot.launch(() =>
      console.log(`[bot] polling started, @${bot.botInfo?.username} is up`),
    );
  }
}

main().catch((err) => {
  console.error("[bot] fatal:", err);
  process.exit(1);
});
