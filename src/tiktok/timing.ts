import os from "node:os";

export const DEBUG_TIMING = process.env.DEBUG_TIMING === "true";

/** No-ops unless DEBUG_TIMING is set; logs elapsed ms since startTime under a `label`. */
export function timeLog(label: string, startTime: number): void {
  if (DEBUG_TIMING) console.warn(`[timing] ${label}: ${Date.now() - startTime}ms`);
}

/** Logs CPU/memory context once at startup, so timing numbers can be correlated against it. */
export function logSystemInfo(): void {
  if (!DEBUG_TIMING) return;
  const cpus = os.cpus();
  console.warn(
    `[timing] system info: cpus=${cpus.length} model=${cpus[0]?.model ?? "unknown"} totalMemMB=${Math.round(
      os.totalmem() / 1024 / 1024,
    )} loadavg=${os.loadavg().map((n) => n.toFixed(2)).join(",")}`,
  );
}
