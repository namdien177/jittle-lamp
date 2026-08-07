import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_VIDEO_UPLOAD_BYTES = 60 * 1024 * 1024;

export type NormalizedVideo = {
	payload: Uint8Array;
	mimeType: "video/mp4";
};

export type VideoNormalizer = (input: {
	payload: Uint8Array;
	mimeType: string;
}) => Promise<NormalizedVideo>;

const inputExtension = (mimeType: string): string => {
	switch (mimeType) {
		case "video/mp4":
			return ".mp4";
		case "image/webp":
			return ".webp";
		default:
			return ".webm";
	}
};

export const normalizeVideoTo720p: VideoNormalizer = async ({
	payload,
	mimeType,
}) => {
	const workDir = await mkdtemp(join(tmpdir(), "jittle-lamp-video-"));
	const inputPath = join(workDir, `input${inputExtension(mimeType)}`);
	const outputPath = join(workDir, "output.mp4");

	try {
		await Bun.write(inputPath, payload);
		const ffmpegProcess = Bun.spawn(
			[
				process.env.FFMPEG_PATH || "ffmpeg",
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-i",
				inputPath,
				"-vf",
				"scale=w='if(gt(iw,1280),1280,iw)':h='if(gt(ih,720),720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-crf",
				"23",
				"-c:a",
				"aac",
				"-b:a",
				"128k",
				"-movflags",
				"+faststart",
				outputPath,
			],
			{ stdout: "ignore", stderr: "pipe" },
		);
		const stderr = await new Response(ffmpegProcess.stderr).text();
		const exitCode = await ffmpegProcess.exited;
		if (exitCode !== 0) {
			throw new Error(
				`Video normalization failed${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
			);
		}

		const normalized = await readFile(outputPath);
		return {
			payload: new Uint8Array(normalized),
			mimeType: "video/mp4",
		};
	} finally {
		await rm(workDir, { recursive: true, force: true });
	}
};
