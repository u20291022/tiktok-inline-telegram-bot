import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DEBUG_TIMING, timeLog } from "./timing";

const execFileAsync = promisify(execFile);

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

/**
 * Computes a rounding-safe (frame count, -t seconds) pair for a given
 * target duration and fps. Rounding fps to 4 decimals for the ffmpeg CLI
 * arg (e.g. 1/68 -> "0.0147") implies a frame period (1/0.0147 = 68.03s)
 * that can land slightly *past* a -t bound set from the un-rounded
 * duration (68.000s) -- when that happens the single frame never
 * completes within the window and ffmpeg silently emits a video track
 * with zero frames. -frames:v caps frame count directly (immune to that
 * rounding), and -t is derived from the same rounded fps so it's always
 * generous enough to contain every frame it's supposed to.
 */
function videoFrameBudget(
  totalSeconds: number,
  fps: number,
): { frameCount: number; durationSeconds: number } {
  const frameCount = Math.max(1, Math.round(totalSeconds * fps));
  const durationSeconds = Math.max(totalSeconds, frameCount / fps) + 0.1;
  return { frameCount, durationSeconds };
}

/**
 * Writes the downloaded slide images and audio to a temp dir and shells
 * out to ffmpeg's concat demuxer to combine them into a single mp4.
 */
export async function composePhotoPostVideo(
  imageFiles: Array<{ buffer: Buffer; contentType: string }>,
  audioFile: { buffer: Buffer; contentType: string },
  perImageSeconds: number,
  width: number,
  height: number,
): Promise<Buffer> {
  const composeStart = Date.now();
  // Aim for roughly one encoded frame per image: perImageSeconds already
  // accounts for the fallback-duration case (never 0), so 1/perImageSeconds
  // is always finite. Capped at 0.33fps (min 3s/image) -- perImageSeconds
  // is bounded from below by that same 3s floor, and bounding a duration
  // from below bounds its reciprocal fps from above, so this must be min()
  // not max() or a long single-image display gets encoded at a needlessly
  // high framerate instead of the ~1 frame it actually needs.
  const outputFps = Math.min(0.33, 1 / perImageSeconds);
  // The value actually passed to ffmpeg (4 decimals) -- used consistently
  // for both the CLI arg and the frame-count/-t arithmetic below so they
  // can never disagree with each other.
  const roundedFps = Number(outputFps.toFixed(4));
  const workDir = await mkdtemp(join(tmpdir(), "tiktok-photopost-"));
  try {
    const writeStart = Date.now();
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
    timeLog("composePhotoPostVideo file writes", writeStart);

    // TikTok's music CDN serves both aac and mp3 despite a shared
    // content-type, so re-encode unless the source is confirmed aac already
    // -- copying an mp3 stream into an mp4 container produces unplayable
    // audio in most players.
    const audioCodec = await detectAudioCodec(audioPath);
    const audioCodecArgs =
      audioCodec === "aac" ? ["-c:a", "copy"] : ["-c:a", "aac"];

    const vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
    const outputPath = join(workDir, "output.mp4");

    if (DEBUG_TIMING) {
      console.warn(
        `[timing] composePhotoPostVideo: images=${imagePaths.length} outputFps=${outputFps.toFixed(4)} branch=${
          imagePaths.length === 1 ? "single-image" : "concat-demuxer"
        }`,
      );
    }

    if (imagePaths.length === 1) {
      // A single static image has no per-slide timing to encode -- looping
      // it directly is simpler and cheaper than routing it through the
      // concat demuxer for one entry.
      const { frameCount, durationSeconds } = videoFrameBudget(
        perImageSeconds,
        roundedFps,
      );
      await runFfmpeg([
        "-y",
        "-loop",
        "1",
        "-framerate",
        roundedFps.toFixed(4),
        "-i",
        imagePaths[0],
        // Loops the audio indefinitely so -shortest trims it down to the
        // video's full intended length, instead of the video getting cut
        // short whenever the display-time floor/fallback makes the images'
        // total duration longer than the actual audio track.
        "-stream_loop",
        "-1",
        "-i",
        audioPath,
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-tune",
        "stillimage",
        "-preset",
        "ultrafast",
        ...audioCodecArgs,
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-shortest",
        // The looped image (-loop 1) and looped audio (-stream_loop -1)
        // are now BOTH infinite streams, so -shortest alone has nothing
        // finite left to cut against and never stops -- -t gives ffmpeg an
        // explicit, unambiguous end time. -frames:v guarantees at least
        // one video frame gets emitted regardless (see videoFrameBudget).
        "-t",
        durationSeconds.toFixed(3),
        "-frames:v",
        String(frameCount),
        "-fflags",
        "+genpts",
        // Production stderr showed libx264 auto-selecting threads=3 on this
        // 2-vCPU box for what's only ~20 output frames -- multi-threading
        // buys nothing there and the worker pool contends with the
        // concurrently-running (single-threaded) aac audio encode, which is
        // what actually dominates runtime for these long-audio posts.
        "-threads",
        "1",
        outputPath,
      ]);
    } else {
      const { frameCount, durationSeconds } = videoFrameBudget(
        perImageSeconds * imagePaths.length,
        roundedFps,
      );
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

      await runFfmpeg([
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        // See the single-image branch above: loop the audio so -shortest
        // trims it to the video's length rather than the reverse.
        "-stream_loop",
        "-1",
        "-i",
        audioPath,
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "stillimage",
        ...audioCodecArgs,
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-shortest",
        // The concat demuxer's per-image "duration" lines already bound the
        // video to a finite length, so -shortest against the now-looped
        // audio is safe here in principle -- but -t and -frames:v are added
        // defensively too (see videoFrameBudget), as an explicit backstop
        // so this branch can never hang or emit zero frames the way the
        // single-image one just did in production.
        "-t",
        durationSeconds.toFixed(3),
        "-frames:v",
        String(frameCount),
        "-r",
        roundedFps.toFixed(4),
        // See the single-image branch above: only a couple dozen frames are
        // ever encoded here regardless of image count, so multi-threaded
        // libx264 just contends with the concurrent audio encode for CPU on
        // this 2-vCPU box instead of speeding anything up.
        "-threads",
        "1",
        outputPath,
      ]);
    }

    const buffer = await readFile(outputPath);
    timeLog("composePhotoPostVideo total", composeStart);
    return buffer;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Returns the audio stream's codec name (e.g. "aac", "mp3"), or null if ffprobe fails/finds none. */
async function detectAudioCodec(audioPath: string): Promise<string | null> {
  const start = Date.now();
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name",
      "-of",
      "csv=p=0",
      audioPath,
    ]);
    timeLog("ffprobe audio codec detection", start);
    return stdout.trim() || null;
  } catch {
    timeLog("ffprobe audio codec detection FAILED", start);
    return null;
  }
}

// Belt-and-suspenders against another infinite-encode bug like the
// -stream_loop one: SIGTERMs ffmpeg instead of hanging forever and
// permanently tying up a browser-pool page slot.
const FFMPEG_TIMEOUT_MS = 120_000;

async function runFfmpeg(args: string[]): Promise<void> {
  const start = Date.now();
  if (DEBUG_TIMING) {
    console.warn(`[timing] runFfmpeg args: ${JSON.stringify(args)}`);
  }
  try {
    const { stderr } = await execFileAsync("ffmpeg", args, {
      maxBuffer: 1024 * 1024 * 64,
      timeout: FFMPEG_TIMEOUT_MS,
    });
    timeLog("runFfmpeg execFile", start);
    if (DEBUG_TIMING) {
      console.warn(`[timing] runFfmpeg stderr:\n${stderr}`);
    }
  } catch (err: any) {
    timeLog("runFfmpeg execFile FAILED", start);
    if (DEBUG_TIMING) {
      console.warn(`[timing] runFfmpeg stderr (failed):\n${err?.stderr ?? ""}`);
    }
    if (err?.code === "ENOENT") {
      throw new Error(
        "ffmpeg is not installed or not on PATH -- required to compose photo-post slideshows",
      );
    }
    throw new Error(`ffmpeg failed to compose photo post: ${err?.stderr ?? err?.message ?? err}`);
  }
}
