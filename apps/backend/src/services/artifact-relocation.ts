import { createHash } from "node:crypto";

import type { ArtifactObjectRef, StorageRegistry } from "./storage-registry";

// When evidence is copied or moved to another organisation, its objects must end up where that
// organisation stores evidence: an organisation must never depend on another organisation's own
// bucket, and one that turned off the JittleLamp storage must not receive objects there. Objects
// already in the right place (both organisations on the JittleLamp storage) are shared as before.

export type RelocatableArtifact = ArtifactObjectRef & {
	mimeType: string;
	checksum: string;
	uploadStatus: string;
};

export type RelocatedArtifact = ArtifactObjectRef & { copied: boolean };

export const normalizeSha256Checksum = (value: string) =>
	value.toLowerCase().replace(/^sha256:/, "");

export const relocateArtifactsForOrg = async (
	registry: StorageRegistry,
	args: { targetOrgId: string; artifacts: RelocatableArtifact[] },
): Promise<RelocatedArtifact[]> => {
	const target = await registry.forWrite(args.targetOrgId);
	const written: ArtifactObjectRef[] = [];
	try {
		const relocated: RelocatedArtifact[] = [];
		for (const artifact of args.artifacts) {
			if (artifact.storageId === target.storageId) {
				relocated.push({
					storageId: artifact.storageId,
					s3Key: artifact.s3Key,
					copied: false,
				});
				continue;
			}
			const s3Key = `uploads/${args.targetOrgId}/relocated/${crypto.randomUUID()}`;
			if (artifact.uploadStatus !== "uploaded") {
				relocated.push({ storageId: target.storageId, s3Key, copied: false });
				continue;
			}
			const source = await registry.forArtifact(artifact);
			const body = await source.getObject({ key: artifact.s3Key });
			const digest = createHash("sha256").update(body).digest();
			if (
				digest.toString("hex") !== normalizeSha256Checksum(artifact.checksum)
			) {
				throw new Error(
					"An artifact does not match the checksum it was uploaded with",
				);
			}
			await target.storage.putObject({
				key: s3Key,
				body,
				contentType: artifact.mimeType,
				checksumSha256: digest.toString("base64"),
			});
			written.push({ storageId: target.storageId, s3Key });
			relocated.push({ storageId: target.storageId, s3Key, copied: true });
		}
		return relocated;
	} catch (error) {
		await registry.deleteObjects(written);
		throw error;
	}
};
