export type VideoThumbnail = {
  base64: string;
  mimeType: string;
};

const THUMBNAIL_MIME_TYPE = "image/jpeg";
const THUMBNAIL_WIDTH = 240;
const THUMBNAIL_HEIGHT = 135;

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
        video.removeEventListener("loadeddata", onLoadedData);
        video.removeEventListener("error", onError);
      };
      const onLoadedData = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("Video metadata could not be loaded."));
      };

      video.addEventListener("loadeddata", onLoadedData, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.src = url;
      video.currentTime = 0;
    });

    const canvas = document.createElement("canvas");
    canvas.width = THUMBNAIL_WIDTH;
    canvas.height = THUMBNAIL_HEIGHT;
    const context = canvas.getContext("2d");
    if (!context) return null;

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
