import { Buffer } from "node:buffer";
import {
	recordingFileName,
	runReportSchema,
	safeParseSessionArchiveJson,
	sessionArchiveFileName,
} from "@jittle-lamp/shared";
import { and, eq } from "drizzle-orm";
import { strFromU8 } from "fflate";

import {
	desktopRecordingSessions,
	evidenceArtifacts,
	evidences,
	testCases,
	testRunSteps,
	testRuns,
} from "../db/schema";
import { HttpError } from "../http/test-http";
import type { ArtifactStorage } from "./artifact-storage";
import {
	evidenceActivityEntity,
	recordOrganizationActivity,
} from "./organization-activity";
import { linkRunEvidence, TEST_RUN_SOURCE_TYPE } from "./test-run-finalize";
import type { TestRunRow } from "./test-runs";
import type { BackendDb } from "./user-provisioning";
import {
	MAX_EVIDENCE_ZIP_UNCOMPRESSED_BYTES,
	unzipBounded,
	ZipTooLargeError,
} from "./zip-limits";

// Evidence upload by run token (design.md §5.3, ADR 0002 decision 4): one ZIP with the
// recording, the v4 session archive and run-report.json (+ screenshots/*.png) becomes a normal
// evidence record with sourceType "test-run" and sourceExternalId = runId.

export const MAX_RUN_EVIDENCE_ZIP_BYTES = 64 * 1024 * 1024;
export const RUN_REPORT_FILE_NAME = "run-report.json";
export { TEST_RUN_SOURCE_TYPE };

const sha256Hex = async (payload: Uint8Array): Promise<string> => {
	const copy = new Uint8Array(payload.byteLength);
	copy.set(payload);
	const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
	return Buffer.from(digest).toString("hex");
};

const screenshotPattern = /^screenshots\/([^/]+)\.(png|jpe?g)$/i;

export const validateRunEvidenceZip = (bytes: Uint8Array, runId: string) => {
	const isExpected = (name: string) =>
		[sessionArchiveFileName, recordingFileName, RUN_REPORT_FILE_NAME].includes(
			name,
		) || screenshotPattern.test(name);
	let files: Record<string, Uint8Array>;
	let names: string[];
	try {
		const unzipped = unzipBounded(bytes, {
			maxUncompressedBytes: MAX_EVIDENCE_ZIP_UNCOMPRESSED_BYTES,
			include: isExpected,
		});
		files = unzipped.files;
		names = unzipped.names.filter((name) => !name.endsWith("/"));
	} catch (error) {
		if (error instanceof ZipTooLargeError) {
			throw new HttpError(
				413,
				"TEST_RUN_EVIDENCE_ZIP_TOO_LARGE",
				`Evidence ${error.message}`,
			);
		}
		throw new HttpError(
			400,
			"TEST_RUN_EVIDENCE_ZIP_INVALID",
			"Upload body must be a readable ZIP archive",
		);
	}
	const unexpected = names.filter((name) => !isExpected(name));
	if (unexpected.length > 0) {
		throw new HttpError(
			400,
			"TEST_RUN_EVIDENCE_ZIP_INVALID",
			`Unexpected files in the ZIP: ${unexpected.slice(0, 5).join(", ")}`,
		);
	}
	const archiveJson = files[sessionArchiveFileName];
	const recording = files[recordingFileName];
	const reportJson = files[RUN_REPORT_FILE_NAME];
	if (!archiveJson || !recording || !reportJson) {
		throw new HttpError(
			400,
			"TEST_RUN_EVIDENCE_ZIP_INVALID",
			`ZIP must contain ${sessionArchiveFileName}, ${recordingFileName} and ${RUN_REPORT_FILE_NAME} at the root`,
		);
	}
	if (recording.byteLength === 0) {
		throw new HttpError(
			400,
			"TEST_RUN_EVIDENCE_ZIP_INVALID",
			`${recordingFileName} must not be empty`,
		);
	}
	const archive = safeParseSessionArchiveJson(archiveJson);
	if (!archive.success) {
		throw new HttpError(
			400,
			"TEST_RUN_EVIDENCE_ZIP_INVALID",
			`Invalid ${sessionArchiveFileName}: ${archive.error.message}`,
		);
	}
	let report: ReturnType<typeof runReportSchema.parse>;
	try {
		report = runReportSchema.parse(JSON.parse(strFromU8(reportJson)));
	} catch (error) {
		throw new HttpError(
			400,
			"TEST_RUN_EVIDENCE_ZIP_INVALID",
			`Invalid ${RUN_REPORT_FILE_NAME}: ${error instanceof Error ? error.message.slice(0, 300) : "unreadable"}`,
		);
	}
	if (report.runId !== null && report.runId !== runId) {
		throw new HttpError(
			422,
			"TEST_RUN_REPORT_MISMATCH",
			"run-report.json belongs to another run",
		);
	}
	const screenshots = names.flatMap((name) => {
		const match = screenshotPattern.exec(name);
		const body = files[name];
		return match && body
			? [
					{
						name,
						stepId: match[1] ?? name,
						mimeType: /png$/i.test(name) ? "image/png" : "image/jpeg",
						body,
					},
				]
			: [];
	});
	return {
		archive: archive.data,
		archiveJson,
		recording,
		reportJson,
		report,
		screenshots,
	};
};

export const storeRunEvidence = async (
	db: BackendDb,
	artifactStorage: ArtifactStorage,
	input: { run: TestRunRow; zip: Uint8Array },
): Promise<{ evidenceId: string; existing: boolean }> => {
	const { run } = input;
	if (run.evidenceId) return { evidenceId: run.evidenceId, existing: true };
	if (!run.createdBy) {
		throw new HttpError(
			409,
			"TEST_RUN_REQUESTER_MISSING",
			"The run's requester no longer exists; evidence cannot be attributed",
		);
	}
	const validated = validateRunEvidenceZip(input.zip, run.id);
	const testCase = await db.query.testCases.findFirst({
		where: eq(testCases.id, run.testCaseId),
		columns: { key: true, title: true },
	});
	const now = Date.now();
	const title =
		`${testCase?.key ?? "Test run"}: ${testCase?.title ?? validated.archive.name}`.slice(
			0,
			200,
		);
	const files = [
		{
			kind: "recording" as const,
			name: "recording",
			mimeType: "video/webm",
			body: validated.recording,
		},
		{
			kind: "network-log" as const,
			name: "archive",
			mimeType: "application/json",
			body: validated.archiveJson,
		},
		{
			kind: "attachment" as const,
			name: "run-report",
			mimeType: "application/json",
			body: validated.reportJson,
		},
		...validated.screenshots.map((shot) => ({
			kind: "screenshot" as const,
			name: `screenshot-${shot.stepId.replace(/[^\w-]/g, "_")}`,
			mimeType: shot.mimeType,
			body: shot.body,
			stepId: shot.stepId,
		})),
	];
	const checksums = await Promise.all(
		files.map((file) => sha256Hex(file.body)),
	);
	const createdBy = run.createdBy;
	const evidence = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(evidences)
			.values({
				orgId: run.orgId,
				createdBy,
				title,
				sourceType: TEST_RUN_SOURCE_TYPE,
				sourceExternalId: run.id,
				sourceMetadata: JSON.stringify({
					runId: run.id,
					testCaseId: run.testCaseId,
					testCaseKey: testCase?.key ?? null,
					transcriptVersion: run.transcriptVersion,
					outcome: validated.report.outcome,
					sessionId: validated.archive.sessionId,
					durationMs: validated.report.durationMs,
					actionCount:
						validated.archive.summary.actionCount ??
						validated.archive.sections.actions.length,
					requestCount:
						validated.archive.summary.requestCount ??
						validated.archive.sections.network.length,
				}),
				scopeType: "organization",
				scopeId: run.orgId,
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: evidences.id });
		if (!created) throw new Error("Failed to create run evidence");
		await tx
			.insert(desktopRecordingSessions)
			.values({
				sessionId: validated.archive.sessionId,
				evidenceId: created.id,
				orgId: run.orgId,
				createdBy,
				sourceMetadata: JSON.stringify({ source: "test-run", runId: run.id }),
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [
					desktopRecordingSessions.orgId,
					desktopRecordingSessions.sessionId,
				],
				set: {
					evidenceId: created.id,
					sourceMetadata: JSON.stringify({ source: "test-run", runId: run.id }),
					updatedAt: now,
				},
			});
		return created;
	});
	const artifacts = await db
		.insert(evidenceArtifacts)
		.values(
			files.map((file, index) => ({
				evidenceId: evidence.id,
				kind: file.kind,
				s3Key: `uploads/${run.orgId}/${evidence.id}/test-run-${file.name}-${crypto.randomUUID()}`,
				mimeType: file.mimeType,
				bytes: file.body.byteLength,
				checksum: `sha256:${checksums[index] ?? ""}`,
				uploadStatus: "uploading" as const,
				createdAt: now,
				updatedAt: now,
			})),
		)
		.returning({ id: evidenceArtifacts.id, s3Key: evidenceArtifacts.s3Key });
	await Promise.all(
		files.map((file, index) => {
			const artifact = artifacts[index];
			if (!artifact) throw new Error("Artifact row missing");
			return artifactStorage.putObject({
				key: artifact.s3Key,
				body: file.body,
				contentType: file.mimeType,
				checksumSha256: Buffer.from(checksums[index] ?? "", "hex").toString(
					"base64",
				),
			});
		}),
	);
	await db
		.update(evidenceArtifacts)
		.set({ uploadStatus: "uploaded", updatedAt: Date.now() })
		.where(
			and(
				eq(evidenceArtifacts.evidenceId, evidence.id),
				eq(evidenceArtifacts.uploadStatus, "uploading"),
			),
		);
	for (const [index, file] of files.entries()) {
		const artifact = artifacts[index];
		if (!artifact || !("stepId" in file)) continue;
		await db
			.update(testRunSteps)
			.set({ screenshotArtifactId: artifact.id, updatedAt: now })
			.where(
				and(
					eq(testRunSteps.runId, run.id),
					eq(testRunSteps.stepId, file.stepId),
				),
			);
	}
	await linkRunEvidence(db, run, evidence.id);
	await db
		.update(testRuns)
		.set({ evidenceId: evidence.id, updatedAt: now })
		.where(eq(testRuns.id, run.id));
	await recordOrganizationActivity(db, {
		organizationId: run.orgId,
		actorUserId: createdBy,
		action: "evidence.created",
		entity: evidenceActivityEntity(evidence.id),
		message: `Created test run evidence for ${testCase?.key ?? run.testCaseId}`,
		metadata: { sourceType: TEST_RUN_SOURCE_TYPE, runId: run.id },
	});
	return { evidenceId: evidence.id, existing: false };
};
