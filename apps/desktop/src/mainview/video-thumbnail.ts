export type VideoThumbnail = {
  base64: string;
  mimeType: string;
};

const THUMBNAIL_MIME_TYPE = "image/jpeg";
const THUMBNAIL_WIDTH = 240;
const THUMBNAIL_HEIGHT = 135;
const THUMBNAIL_CANDIDATE_SECONDS = [2.5, 3, 4, 1, 0] as const;

export async function createVideoThumbnail(
  recording: Blob,
): Promise<VideoThumbnail | null> {
  const url = URL.createObjectURL(recording);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("error", onError);
      };
      const onLoadedMetadata = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("Video metadata could not be loaded."));
      };

      video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = THUMBNAIL_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) return null;

    const duration = mediaDuration(video);
    let drewFrame = false;

    for (const candidate of THUMBNAIL_CANDIDATE_SECONDS) {
      const targetTime = clampThumbnailTime(candidate, duration);
      await seekVideoFrame(video, targetTime);
      drawVideoThumbnailFrame(video, context);
      drewFrame = true;

      if (!isMostlyBlackFrame(context)) {
        break;
      }
    }

    if (!drewFrame) return null;

    const dataUrl = canvas.toDataURL(THUMBNAIL_MIME_TYPE, 0.72);
    return {
      base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      mimeType: THUMBNAIL_MIME_TYPE,
    };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function seekVideoFrame(
  video: HTMLVideoElement,
  targetTime: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve();
    }, 2500);
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = (): void => {
      cleanup();
      waitForDecodedVideoFrame(video).then(resolve, reject);
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Video thumbnail seek failed."));
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });

    if (Math.abs(video.currentTime - targetTime) < 0.05) {
      onSeeked();
      return;
    }

    video.currentTime = targetTime;
  });
}

async function waitForDecodedVideoFrame(video: HTMLVideoElement): Promise<void> {
  const requestVideoFrameCallback = video.requestVideoFrameCallback?.bind(video);

  if (!requestVideoFrameCallback) {
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, 300);
    requestVideoFrameCallback(() => {
      window.clearTimeout(timeout);
      resolve();
    });
  });
}

function mediaDuration(video: HTMLVideoElement): number {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    return video.duration;
  }

  if (video.seekable.length > 0) {
    const seekableEnd = video.seekable.end(video.seekable.length - 1);
    if (Number.isFinite(seekableEnd) && seekableEnd > 0) {
      return seekableEnd;
    }
  }

  return 0;
}

function clampThumbnailTime(seconds: number, duration: number): number {
  if (duration <= 0) {
    return seconds;
  }

  return Math.max(0, Math.min(seconds, Math.max(0, duration - 0.25)));
}

function drawVideoThumbnailFrame(
  video: HTMLVideoElement,
  context: CanvasRenderingContext2D,
): void {
  const sourceWidth = video.videoWidth || THUMBNAIL_WIDTH;
  const sourceHeight = video.videoHeight || THUMBNAIL_HEIGHT;
  const scale = Math.max(
    THUMBNAIL_WIDTH / sourceWidth,
    THUMBNAIL_HEIGHT / sourceHeight,
  );
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(
    video,
    (THUMBNAIL_WIDTH - drawWidth) / 2,
    (THUMBNAIL_HEIGHT - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

function isMostlyBlackFrame(context: CanvasRenderingContext2D): boolean {
  const sample = context.getImageData(0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT).data;
  let brightPixels = 0;
  const pixelCount = sample.length / 4;

  for (let index = 0; index < sample.length; index += 16) {
    const brightness = sample[index]! + sample[index + 1]! + sample[index + 2]!;
    if (brightness > 48) {
      brightPixels += 1;
    }
  }

  return brightPixels / Math.max(1, pixelCount / 4) < 0.015;
}
