import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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

async function runFfmpeg(args: string[]): Promise<void> {
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
