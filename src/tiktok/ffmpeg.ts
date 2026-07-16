import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { timeLog } from "./timing";

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
  // is always finite. Floored at 0.33fps (1 frame/3s) so very long
  // single-image displays still stay seekable/compatible in players.
  const outputFps = Math.max(0.33, 1 / perImageSeconds);
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

    if (imagePaths.length === 1) {
      // A single static image has no per-slide timing to encode -- looping
      // it directly is simpler and cheaper than routing it through the
      // concat demuxer for one entry.
      await runFfmpeg([
        "-y",
        "-loop",
        "1",
        "-framerate",
        outputFps.toFixed(4),
        "-i",
        imagePaths[0],
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
        "-fflags",
        "+genpts",
        "-threads",
        "0",
        outputPath,
      ]);
    } else {
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
        "-r",
        outputFps.toFixed(4),
        "-threads",
        "0",
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

async function runFfmpeg(args: string[]): Promise<void> {
  const start = Date.now();
  try {
    await execFileAsync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 64 });
    timeLog("runFfmpeg execFile", start);
  } catch (err: any) {
    timeLog("runFfmpeg execFile FAILED", start);
    if (err?.code === "ENOENT") {
      throw new Error(
        "ffmpeg is not installed or not on PATH -- required to compose photo-post slideshows",
      );
    }
    throw new Error(`ffmpeg failed to compose photo post: ${err?.stderr ?? err?.message ?? err}`);
  }
}
