import { api, type ApiEvidenceSummary, type FetchToken } from "./api";
import { createVideoThumbnail } from "./video-thumbnail";

type PreparedSessionUpload = {
  sessionId: string;
  title: string;
  artifacts: Array<{
    key: "recording" | "archive" | "playback";
    kind: "recording" | "network-log";
    mimeType: string;
    bytes: number;
    checksum: string;
    payload: Uint8Array;
  }>;
};

export async function syncDesktopSessionToServer(input: {
  getToken: FetchToken;
  sessionId: string;
  replaceEvidenceId?: string;
  prepareSessionUpload: (sessionId: string) => Promise<PreparedSessionUpload>;
  markSessionRemoteSynced: (input: { sessionId: string; evidenceId: string; orgId: string }) => Promise<void>;
}): Promise<ApiEvidenceSummary> {
  const upload = await input.prepareSessionUpload(input.sessionId);
  const recordingArtifact = upload.artifacts.find((artifact) => artifact.key === "recording");
  const thumbnail = recordingArtifact
    ? await createVideoThumbnail(new Blob([recordingArtifact.payload.slice().buffer as ArrayBuffer], { type: recordingArtifact.mimeType }))
    : null;
  const sourceMetadata = JSON.stringify({
    localSessionId: upload.sessionId,
    artifactFormat: "split",
    artifacts: upload.artifacts.map((artifact) => ({
      key: artifact.key,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes,
      checksum: artifact.checksum
    }))
  });
  const started = await api.startDesktopSessionSync(input.getToken, {
    sessionId: upload.sessionId,
    title: upload.title,
    sourceMetadata,
    ...(thumbnail
      ? {
          thumbnailBase64: thumbnail.base64,
          thumbnailMimeType: thumbnail.mimeType
        }
      : {}),
    ...(input.replaceEvidenceId ? { replaceEvidenceId: input.replaceEvidenceId } : {}),
    artifacts: upload.artifacts.map((artifact) => ({
      key: artifact.key,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes,
      checksum: artifact.checksum
    }))
  });

  for (const artifact of upload.artifacts) {
    const uploadSession = started.uploadSessions.find((candidate) => candidate.key === artifact.key);
    if (!uploadSession) throw new Error(`Missing upload session for ${artifact.key}`);
    await api.uploadEvidenceBlob(input.getToken, uploadSession.uploadUrl, artifact.payload, artifact.mimeType);
    await api.completeEvidenceUpload(input.getToken, uploadSession.uploadId, {
      bytes: artifact.bytes,
      checksum: artifact.checksum,
      mimeType: artifact.mimeType
    });
  }

  await input.markSessionRemoteSynced({
    sessionId: input.sessionId,
    evidenceId: started.evidenceId,
    orgId: started.organizationId
  });

  return {
    id: started.evidenceId,
    orgId: started.organizationId,
    title: upload.title,
    sourceType: "desktop-session",
    sourceExternalId: upload.sessionId,
    sourceMetadata,
    thumbnailBase64: thumbnail?.base64 ?? null,
    thumbnailMimeType: thumbnail?.mimeType ?? null,
    createdBy: "",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}
