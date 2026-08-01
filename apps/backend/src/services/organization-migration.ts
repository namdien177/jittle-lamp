import {
	canonicalHash,
	MIGRATION_PROTOCOL_VERSION,
	type MigrationCompatibility,
	type MigrationHandshakeRequest,
	type MigrationLink,
	type MigrationManifestEntry,
	type MigrationRecord,
	type MigrationRun,
	type MigrationStatus,
	orderedManifestHash,
	type PairOutboundInput,
	type ReceiverCode,
} from "@jittle-lamp/shared";
import {
	and,
	desc,
	eq,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	or,
} from "drizzle-orm";

import type { RuntimeConfig } from "../config/runtime";
import {
	aiAccessTokens,
	aiAccessTokenUsageLogs,
	automationApiTokens,
	desktopRecordingSessions,
	evidenceArtifacts,
	evidenceComments,
	evidences,
	evidenceTagAssignments,
	jittleLampInstances,
	migrationEntityMappings,
	migrationIdentityMappings,
	migrationReceiverCodes,
	organizationActivityLogs,
	organizationEvidenceTags,
	organizationInvitationCodes,
	organizationInvitations,
	organizationJoinRequests,
	organizationMembers,
	organizationMigrationItems,
	organizationMigrationLinks,
	organizationMigrationRuns,
	organizationMigrationStates,
	organizationRoles,
	organizations,
	shareLinks,
	users,
} from "../db/schema";
import type { ArtifactStorage } from "./artifact-storage";
import type { ClerkDirectory } from "./clerk-directory";
import type { MigrationPeerClient } from "./migration-peer-client";
import {
	createMigrationCryptography,
	createMigrationEmailProof,
	createMigrationPassphrase,
	type MigrationCryptography,
	validateMigrationTargetOrigin,
} from "./migration-security";
import {
	type ClaimedMigrationRun,
	type MigrationRunHandler,
	MigrationWorkerError,
} from "./migration-worker";
import { ensureDefaultOrganizationRoles } from "./organization-permissions";
import type { BackendDb } from "./user-provisioning";

const RECEIVER_CODE_TTL_MS = 15 * 60 * 1_000;
const ACTIVE_RUN_STATUSES = [
	"queued",
	"running",
	"waiting_peer",
	"pause_requested",
	"paused",
] as const;
const REQUIRED_MIGRATION_FEATURES = [
	"resumable-import",
	"delta-sync",
	"two-phase-finalization",
	"checksum-verification",
] as const;

export class OrganizationMigrationError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status = 400,
	) {
		super(message);
		this.name = "OrganizationMigrationError";
	}
}

export type OrganizationMigration = {
	createReceiverCode(actorUserId: string): Promise<ReceiverCode>;
	pairOutbound(input: PairOutboundInput): Promise<MigrationLink>;
	startRun(
		orgId: string,
		kind: "full" | "delta" | "final",
	): Promise<MigrationRun>;
	pauseRun(runId: string): Promise<void>;
	resumeRun(runId: string): Promise<void>;
	retryRun(runId: string, override: boolean): Promise<void>;
	abortFinalization(orgId: string): Promise<void>;
	breakFinalizedLink(orgId: string): Promise<void>;
	getStatus(actorUserId: string, orgId?: string): Promise<MigrationStatus>;
};

export type OrganizationMigrationService = OrganizationMigration & {
	cleanupMaintenance(): Promise<{ receiverCodes: number; payloads: number }>;
	checkCompatibility(
		actorUserId: string,
		organizationId: string,
		targetApiOrigin: string,
	): Promise<MigrationCompatibility>;
	revokeReceiverCode(actorUserId: string, codeId: string): Promise<void>;
	listInbound(actorUserId: string): Promise<MigrationStatus[]>;
	acceptHandshake(input: MigrationHandshakeRequest): Promise<{
		linkId: string;
		destinationInstanceId: string;
		destinationOrganizationId: string;
		destinationWebOrigin: string;
		protocolVersion: string;
		sessionToken: string;
	}>;
	getInstanceId(): Promise<string>;
	processRun: MigrationRunHandler;
	openInboundRun(
		linkId: string,
		sessionToken: string,
		request: {
			sourceRunId: string;
			kind: "full" | "delta" | "final";
			manifestHash: string;
			override: boolean;
		},
	): Promise<{ runId: string; verifiedHashes: string[] }>;
	putInboundManifestPage(
		linkId: string,
		sessionToken: string,
		runId: string,
		page: number,
		request: {
			contentHash: string;
			entries: MigrationManifestEntry[];
			isLast: boolean;
		},
	): Promise<void>;
	putInboundRecordPage(
		linkId: string,
		sessionToken: string,
		runId: string,
		page: number,
		request: { contentHash: string; records: MigrationRecord[] },
	): Promise<void>;
	putInboundArtifact(
		linkId: string,
		sessionToken: string,
		runId: string,
		artifactId: string,
		request: {
			body: Uint8Array;
			contentHash: string;
			contentType: string;
			size: number;
		},
	): Promise<void>;
	commitInboundRun(
		linkId: string,
		sessionToken: string,
		runId: string,
		request: {
			manifestHash: string;
			recordCount: number;
			artifactCount: number;
			totalBytes: number;
		},
	): Promise<{ status: string; receipt?: string }>;
	getInboundRun(
		linkId: string,
		sessionToken: string,
		runId: string,
	): Promise<Record<string, unknown>>;
	finalizeInbound(
		linkId: string,
		sessionToken: string,
		receipt: string,
	): Promise<void>;
	markInboundDiverged(linkId: string, sessionToken: string): Promise<void>;
};

export type Clock = { now(): number };

const fromBase64Url = (value: string): Uint8Array =>
	Uint8Array.from(Buffer.from(value, "base64url"));
const toBase64Url = (value: Uint8Array): string =>
	Buffer.from(value).toString("base64url");

const parseWarnings = (value: string): string[] => {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((item) => typeof item === "string")
			: [];
	} catch {
		return [];
	}
};

const toRun = (
	row: typeof organizationMigrationRuns.$inferSelect,
): MigrationRun => ({
	id: row.id,
	linkId: row.linkId,
	organizationId: row.organizationId ?? "00000000-0000-0000-0000-000000000000",
	kind: row.kind,
	status: row.status,
	stage: row.stage,
	override: row.override,
	progress: {
		identities: { completed: row.identityCompleted, total: row.identityTotal },
		records: { completed: row.recordCompleted, total: row.recordTotal },
		artifacts: { completed: row.artifactCompleted, total: row.artifactTotal },
		bytes: { transferred: row.bytesTransferred, total: row.bytesTotal },
		warnings: parseWarnings(row.warningsJson),
	},
	errorCode: row.errorCode,
	errorMessage: row.errorMessage,
	attempts: row.attempts,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
	completedAt: row.completedAt,
});

const toLink = (
	row: typeof organizationMigrationLinks.$inferSelect,
): MigrationLink => ({
	id: row.id,
	direction: row.direction,
	localOrganizationId: row.localOrganizationId,
	remoteOrganizationId: row.remoteOrganizationId,
	remoteInstanceId: row.remoteInstanceId,
	remoteApiOrigin: row.remoteApiOrigin,
	remoteWebOrigin: row.remoteWebOrigin,
	protocolVersion: row.protocolVersion,
	state: row.state,
	lastSuccessfulAt: row.lastSuccessfulAt,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const protocolMajor = (version: string): string => version.split(".")[0] ?? "";

export const createOrganizationMigration = (input: {
	db: BackendDb;
	runtime: RuntimeConfig;
	artifactStorage: ArtifactStorage;
	peerClient: MigrationPeerClient;
	clerkDirectory: ClerkDirectory;
	directoryConfigured?: boolean;
	clock?: Clock;
	cryptography?: MigrationCryptography;
	validateTarget?: typeof validateMigrationTargetOrigin;
}): OrganizationMigrationService => {
	const now = () => (input.clock ?? { now: Date.now }).now();
	const cryptography = input.cryptography ?? createMigrationCryptography();
	const validateTarget = input.validateTarget ?? validateMigrationTargetOrigin;
	const recordMigrationActivity = async (activity: {
		organizationId: string;
		action: string;
		message: string;
		actorUserId?: string | null;
		entityId?: string | null;
	}): Promise<void> => {
		await input.db.insert(organizationActivityLogs).values({
			organizationId: activity.organizationId,
			actorUserId: activity.actorUserId ?? null,
			action: activity.action,
			entityType: "organization_migration",
			entityId: activity.entityId ?? null,
			message: activity.message,
			metadataJson: "{}",
			createdAt: now(),
		});
	};
	const migrationPeerRequest = async <T>(
		operation: () => Promise<T>,
	): Promise<T> => {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof MigrationWorkerError) throw error;
			throw new MigrationWorkerError(
				"PEER_TIMEOUT",
				error instanceof Error
					? error.message
					: "Migration peer request failed",
				true,
			);
		}
	};

	const getInstanceId = async (): Promise<string> => {
		await input.db
			.insert(jittleLampInstances)
			.values({ singleton: 1 })
			.onConflictDoNothing();
		const instance = await input.db.query.jittleLampInstances.findFirst();
		if (!instance)
			throw new Error("Failed to persist the Jittle Lamp instance ID");
		return instance.id;
	};

	const assertReceiverReady = async (): Promise<void> => {
		const missing = [
			!input.runtime.databaseUrl && "DATABASE_URL",
			!input.runtime.secret && "APP_SECRET",
			!input.runtime.clerkSecretKey &&
				!input.directoryConfigured &&
				"CLERK_SECRET_KEY",
			!input.runtime.apiOrigin && "JITTLE_LAMP_API_ORIGIN",
			!input.runtime.webAppOrigin && "WEB_APP_ORIGIN",
			input.runtime.nodeEnv === "production" &&
				input.artifactStorage.mode !== "s3" &&
				"production S3 storage",
		].filter((value): value is string => Boolean(value));
		if (missing.length > 0) {
			throw new OrganizationMigrationError(
				"MIGRATION_NOT_CONFIGURED",
				`Organization migration requires ${missing.join(", ")}`,
				503,
			);
		}
		const key = `migration-canary/${crypto.randomUUID()}`;
		const body = new TextEncoder().encode("jittle-lamp-migration-canary");
		try {
			await input.artifactStorage.putObject({
				key,
				body,
				contentType: "application/octet-stream",
				checksumSha256: await cryptography.sha256(body),
			});
			const read = await input.artifactStorage.getObject({ key });
			if (
				(await cryptography.sha256(read)) !== (await cryptography.sha256(body))
			) {
				throw new Error("storage canary checksum mismatch");
			}
		} catch (error) {
			throw new OrganizationMigrationError(
				"MIGRATION_STORAGE_UNAVAILABLE",
				error instanceof Error
					? error.message
					: "Migration storage canary failed",
				503,
			);
		} finally {
			await input.artifactStorage.deleteObject({ key }).catch(() => undefined);
		}
	};

	const assertAdmin = async (actorUserId: string, organizationId: string) => {
		const organization = await input.db.query.organizations.findFirst({
			where: eq(organizations.id, organizationId),
		});
		if (!organization || organization.isPersonal) {
			throw new OrganizationMigrationError(
				"MIGRATION_TEAM_ORGANIZATION_REQUIRED",
				"Only team organizations can be migrated",
				400,
			);
		}
		const membership = await input.db.query.organizationMembers.findFirst({
			where: and(
				eq(organizationMembers.organizationId, organizationId),
				eq(organizationMembers.userId, actorUserId),
				eq(organizationMembers.role, "admin"),
				isNull(organizationMembers.teamId),
			),
		});
		if (!membership) {
			throw new OrganizationMigrationError(
				"MIGRATION_ADMIN_REQUIRED",
				"Organization admin access is required",
				403,
			);
		}
		return organization;
	};

	const getStatusForLink = async (
		link: typeof organizationMigrationLinks.$inferSelect,
	): Promise<MigrationStatus> => {
		const run = await input.db.query.organizationMigrationRuns.findFirst({
			where: eq(organizationMigrationRuns.linkId, link.id),
			orderBy: desc(organizationMigrationRuns.createdAt),
		});
		const state = link.localOrganizationId
			? await input.db.query.organizationMigrationStates.findFirst({
					where: eq(
						organizationMigrationStates.organizationId,
						link.localOrganizationId,
					),
				})
			: null;
		return {
			link: toLink(link),
			run: run ? toRun(run) : null,
			accessState: state?.accessState ?? null,
			destinationWebOrigin:
				state?.destinationWebOrigin ?? link.remoteWebOrigin ?? null,
			verificationReceipt:
				state?.verificationReceipt ?? link.verificationReceipt,
		};
	};

	const createReceiverCode = async (
		actorUserId: string,
	): Promise<ReceiverCode> => {
		await assertReceiverReady();
		const actor = await input.db.query.users.findFirst({
			where: eq(users.id, actorUserId),
		});
		if (!actor) {
			throw new OrganizationMigrationError(
				"MIGRATION_ACTOR_NOT_FOUND",
				"Local user not found",
				403,
			);
		}
		const codeId = crypto.randomUUID();
		const passphrase = createMigrationPassphrase(cryptography, codeId);
		const createdAt = now();
		const [code] = await input.db.transaction(async (tx) => {
			await tx
				.update(migrationReceiverCodes)
				.set({ revokedAt: createdAt })
				.where(
					and(
						eq(migrationReceiverCodes.createdByUserId, actorUserId),
						isNull(migrationReceiverCodes.redeemedAt),
						isNull(migrationReceiverCodes.revokedAt),
					),
				);
			return tx
				.insert(migrationReceiverCodes)
				.values({
					id: codeId,
					createdByUserId: actorUserId,
					passphraseHash: await cryptography.sha256(passphrase),
					expiresAt: createdAt + RECEIVER_CODE_TTL_MS,
					createdAt,
				})
				.returning();
		});
		if (!code || !input.runtime.apiOrigin)
			throw new Error("Receiver code was not created");
		return {
			id: code.id,
			passphrase,
			apiOrigin: input.runtime.apiOrigin,
			expiresAt: code.expiresAt,
			createdAt: code.createdAt,
		};
	};

	const probeCompatibility = async (
		targetApiOriginInput: string,
	): Promise<MigrationCompatibility> => {
		const targetApiOrigin = await validateTarget({
			origin: targetApiOriginInput,
			nodeEnv: input.runtime.nodeEnv,
			allowPrivateNetworks: true,
		});
		let discovery: Awaited<ReturnType<MigrationPeerClient["discover"]>>;
		try {
			discovery = await input.peerClient.discover(targetApiOrigin);
		} catch (error) {
			throw new OrganizationMigrationError(
				"MIGRATION_PEER_UNREACHABLE",
				error instanceof Error
					? error.message
					: "Destination compatibility endpoint is unreachable",
				502,
			);
		}
		const sourceInstanceId = await getInstanceId();
		if (discovery.instanceId === sourceInstanceId) {
			throw new OrganizationMigrationError(
				"MIGRATION_SAME_INSTANCE",
				"Source and destination must be different Jittle Lamp instances",
				409,
			);
		}
		if (
			protocolMajor(discovery.protocolVersion) !==
			protocolMajor(MIGRATION_PROTOCOL_VERSION)
		) {
			throw new OrganizationMigrationError(
				"MIGRATION_PROTOCOL_INCOMPATIBLE",
				`Destination protocol ${discovery.protocolVersion} is incompatible`,
				409,
			);
		}
		const missingFeatures = REQUIRED_MIGRATION_FEATURES.filter(
			(feature) => !discovery.features.includes(feature),
		);
		if (missingFeatures.length > 0) {
			throw new OrganizationMigrationError(
				"MIGRATION_FEATURES_INCOMPATIBLE",
				`Destination is missing migration features: ${missingFeatures.join(", ")}`,
				409,
			);
		}
		return {
			targetApiOrigin,
			targetWebOrigin: discovery.webOrigin,
			instanceId: discovery.instanceId,
			applicationVersion: discovery.applicationVersion,
			protocolVersion: discovery.protocolVersion,
			compatible: true,
			features: discovery.features,
			limits: discovery.limits,
		};
	};

	const checkCompatibility = async (
		actorUserId: string,
		organizationId: string,
		targetApiOriginInput: string,
	): Promise<MigrationCompatibility> => {
		await assertReceiverReady();
		await assertAdmin(actorUserId, organizationId);
		return probeCompatibility(targetApiOriginInput);
	};

	const pairOutbound = async (
		pairInput: PairOutboundInput,
	): Promise<MigrationLink> => {
		await assertReceiverReady();
		const organization = await assertAdmin(
			pairInput.actorUserId,
			pairInput.organizationId,
		);
		const existing = await input.db.query.organizationMigrationLinks.findFirst({
			where: and(
				eq(organizationMigrationLinks.localOrganizationId, organization.id),
				ne(organizationMigrationLinks.state, "broken"),
			),
		});
		if (existing) {
			throw new OrganizationMigrationError(
				"MIGRATION_LINK_EXISTS",
				"This organization already has a migration link",
				409,
			);
		}
		const compatibility = await probeCompatibility(pairInput.targetApiOrigin);
		const targetApiOrigin = compatibility.targetApiOrigin;
		const sourceInstanceId = await getInstanceId();
		const admins = await input.db
			.select({ clerkUserId: users.clerkUserId })
			.from(organizationMembers)
			.innerJoin(users, eq(users.id, organizationMembers.userId))
			.where(
				and(
					eq(organizationMembers.organizationId, organization.id),
					eq(organizationMembers.role, "admin"),
					isNull(organizationMembers.teamId),
				),
			);
		const emailHints: string[] = [];
		for (const admin of admins) {
			const profile = await input.clerkDirectory.exportProfile(
				admin.clerkUserId,
			);
			if (!profile.verifiedPrimaryEmail) continue;
			emailHints.push(
				await createMigrationEmailProof(
					cryptography,
					pairInput.passphrase,
					profile.verifiedPrimaryEmail,
				),
			);
		}
		if (emailHints.length === 0) {
			throw new OrganizationMigrationError(
				"MIGRATION_ADMIN_EMAIL_REQUIRED",
				"At least one source admin needs a verified primary email",
				409,
			);
		}
		const dataKey = cryptography.randomBytes(32);
		const request: MigrationHandshakeRequest = {
			passphrase: pairInput.passphrase,
			sourceInstanceId,
			sourceOrganizationId: organization.id,
			sourceOrganizationName: organization.name,
			sourceApiOrigin: input.runtime.apiOrigin as string,
			sourceWebOrigin: input.runtime.webAppOrigin as string,
			protocolVersion: MIGRATION_PROTOCOL_VERSION,
			operatorProof: await cryptography.hmac(
				pairInput.passphrase,
				`${sourceInstanceId}:${organization.id}:${[...emailHints].sort().join(":")}`,
			),
			operatorEmailHints: emailHints,
			encryptedLinkKey: await cryptography.encrypt(
				pairInput.passphrase,
				toBase64Url(dataKey),
			),
		};
		const handshake = await input.peerClient.handshake(
			targetApiOrigin,
			request,
		);
		const createdAt = now();
		const [link] = await input.db.transaction(async (tx) => {
			const [created] = await tx
				.insert(organizationMigrationLinks)
				.values({
					id: handshake.linkId,
					direction: "outbound",
					localOrganizationId: organization.id,
					remoteOrganizationId: handshake.destinationOrganizationId,
					remoteInstanceId: handshake.destinationInstanceId,
					remoteApiOrigin: targetApiOrigin,
					remoteWebOrigin: handshake.destinationWebOrigin,
					protocolVersion: handshake.protocolVersion,
					encryptedSessionToken: await cryptography.encrypt(
						input.runtime.secret as string,
						handshake.sessionToken,
					),
					encryptedDataKey: await cryptography.encrypt(
						input.runtime.secret as string,
						toBase64Url(dataKey),
					),
					createdAt,
					updatedAt: createdAt,
				})
				.returning();
			if (!created) throw new Error("Migration link was not created");
			await tx.insert(organizationMigrationStates).values({
				organizationId: organization.id,
				linkId: created.id,
				role: "source",
				accessState: "writable",
				destinationWebOrigin: handshake.destinationWebOrigin,
				createdAt,
				updatedAt: createdAt,
			});
			await tx.insert(organizationMigrationRuns).values({
				linkId: created.id,
				organizationId: organization.id,
				sourceRunId: crypto.randomUUID(),
				kind: "full",
				createdAt,
				updatedAt: createdAt,
			});
			return [created];
		});
		if (!link) throw new Error("Migration link was not created");
		await recordMigrationActivity({
			organizationId: organization.id,
			actorUserId: pairInput.actorUserId,
			action: "migration.paired",
			message: "Organization migration paired and initial sync queued",
			entityId: link.id,
		});
		return toLink(link);
	};

	const startRun = async (
		orgId: string,
		kind: "full" | "delta" | "final",
	): Promise<MigrationRun> => {
		const link = await input.db.query.organizationMigrationLinks.findFirst({
			where: and(
				eq(organizationMigrationLinks.localOrganizationId, orgId),
				eq(organizationMigrationLinks.direction, "outbound"),
			),
		});
		if (!link || ["broken", "diverged"].includes(link.state)) {
			throw new OrganizationMigrationError(
				"MIGRATION_LINK_NOT_ACTIVE",
				"No active migration link",
				404,
			);
		}
		const active = await input.db.query.organizationMigrationRuns.findFirst({
			where: and(
				eq(organizationMigrationRuns.organizationId, orgId),
				inArray(organizationMigrationRuns.status, [...ACTIVE_RUN_STATUSES]),
			),
		});
		if (active) {
			throw new OrganizationMigrationError(
				"MIGRATION_RUN_ACTIVE",
				"A migration run is already active",
				409,
			);
		}
		const createdAt = now();
		const [run] = await input.db.transaction(async (tx) => {
			if (kind === "final") {
				await tx
					.update(organizationMigrationStates)
					.set({ accessState: "finalizing_read_only", updatedAt: createdAt })
					.where(eq(organizationMigrationStates.organizationId, orgId));
				await tx
					.update(organizationMigrationLinks)
					.set({ state: "finalizing", updatedAt: createdAt })
					.where(eq(organizationMigrationLinks.id, link.id));
			}
			return tx
				.insert(organizationMigrationRuns)
				.values({
					linkId: link.id,
					organizationId: orgId,
					sourceRunId: crypto.randomUUID(),
					kind,
					createdAt,
					updatedAt: createdAt,
				})
				.returning();
		});
		if (!run) throw new Error("Migration run was not created");
		await recordMigrationActivity({
			organizationId: orgId,
			action:
				kind === "final"
					? "migration.finalization-started"
					: "migration.sync-queued",
			message:
				kind === "final"
					? "Migration finalization started"
					: `${kind} migration sync queued`,
			entityId: run.id,
		});
		return toRun(run);
	};

	const pauseRun = async (runId: string): Promise<void> => {
		const current = await input.db.query.organizationMigrationRuns.findFirst({
			where: eq(organizationMigrationRuns.id, runId),
			columns: { status: true },
		});
		const [run] = await input.db
			.update(organizationMigrationRuns)
			.set({
				status: current?.status === "queued" ? "paused" : "pause_requested",
				updatedAt: now(),
			})
			.where(
				and(
					eq(organizationMigrationRuns.id, runId),
					inArray(organizationMigrationRuns.status, [
						"queued",
						"running",
						"waiting_peer",
					]),
				),
			)
			.returning();
		if (!run)
			throw new OrganizationMigrationError(
				"MIGRATION_RUN_NOT_PAUSABLE",
				"Run is not active",
				409,
			);
		await recordMigrationActivity({
			organizationId: run.organizationId as string,
			action: "migration.run-paused",
			message: "Migration pause requested",
			entityId: run.id,
		});
	};

	const resumeRun = async (runId: string): Promise<void> => {
		const [run] = await input.db
			.update(organizationMigrationRuns)
			.set({ status: "queued", nextAttemptAt: null, updatedAt: now() })
			.where(
				and(
					eq(organizationMigrationRuns.id, runId),
					inArray(organizationMigrationRuns.status, [
						"paused",
						"pause_requested",
					]),
				),
			)
			.returning();
		if (!run)
			throw new OrganizationMigrationError(
				"MIGRATION_RUN_NOT_RESUMABLE",
				"Run is not paused",
				409,
			);
		await recordMigrationActivity({
			organizationId: run.organizationId as string,
			action: "migration.run-resumed",
			message: "Migration run resumed",
			entityId: run.id,
		});
	};

	const retryRun = async (runId: string, override: boolean): Promise<void> => {
		const [run] = await input.db
			.update(organizationMigrationRuns)
			.set({
				status: "queued",
				sourceRunId: crypto.randomUUID(),
				override,
				nextAttemptAt: null,
				errorCode: null,
				errorMessage: null,
				identityCompleted: 0,
				recordCompleted: 0,
				artifactCompleted: 0,
				bytesTransferred: 0,
				updatedAt: now(),
			})
			.where(
				and(
					eq(organizationMigrationRuns.id, runId),
					eq(organizationMigrationRuns.status, "failed"),
				),
			)
			.returning();
		if (!run)
			throw new OrganizationMigrationError(
				"MIGRATION_RUN_NOT_RETRYABLE",
				"Run is not failed",
				409,
			);
		await recordMigrationActivity({
			organizationId: run.organizationId as string,
			action: override ? "migration.override-retry" : "migration.retry",
			message: override
				? "Migration retry with override queued"
				: "Migration retry queued",
			entityId: run.id,
		});
	};

	const abortFinalization = async (orgId: string): Promise<void> => {
		const finalRun = await input.db.query.organizationMigrationRuns.findFirst({
			where: and(
				eq(organizationMigrationRuns.organizationId, orgId),
				eq(organizationMigrationRuns.kind, "final"),
				inArray(organizationMigrationRuns.status, [
					"paused",
					"pause_requested",
					"failed",
					"queued",
				]),
			),
			orderBy: desc(organizationMigrationRuns.createdAt),
		});
		if (!finalRun)
			throw new OrganizationMigrationError(
				"MIGRATION_FINALIZATION_NOT_ABORTABLE",
				"No recoverable finalization exists",
				409,
			);
		const link = await input.db.query.organizationMigrationLinks.findFirst({
			where: eq(organizationMigrationLinks.id, finalRun.linkId),
			columns: { state: true },
		});
		if (link?.state !== "finalizing") {
			throw new OrganizationMigrationError(
				"MIGRATION_FINALIZATION_ACK_PENDING",
				"The destination receipt was verified; resume or retry the acknowledgement instead",
				409,
			);
		}
		await input.db.transaction(async (tx) => {
			await tx
				.update(organizationMigrationRuns)
				.set({ status: "cancelled", completedAt: now(), updatedAt: now() })
				.where(eq(organizationMigrationRuns.id, finalRun.id));
			await tx
				.update(organizationMigrationStates)
				.set({ accessState: "writable", updatedAt: now() })
				.where(eq(organizationMigrationStates.organizationId, orgId));
			await tx
				.update(organizationMigrationLinks)
				.set({ state: "synced", updatedAt: now() })
				.where(eq(organizationMigrationLinks.id, finalRun.linkId));
		});
		await recordMigrationActivity({
			organizationId: orgId,
			action: "migration.finalization-aborted",
			message: "Migration finalization aborted",
			entityId: finalRun.linkId,
		});
	};

	const breakFinalizedLink = async (orgId: string): Promise<void> => {
		const link = await input.db.query.organizationMigrationLinks.findFirst({
			where: and(
				eq(organizationMigrationLinks.localOrganizationId, orgId),
				eq(organizationMigrationLinks.state, "completed"),
			),
		});
		if (!link)
			throw new OrganizationMigrationError(
				"MIGRATION_LINK_NOT_BREAKABLE",
				"Only a completed link can be broken",
				409,
			);
		await input.db.transaction(async (tx) => {
			await tx
				.update(organizationMigrationLinks)
				.set({ state: "diverged", updatedAt: now() })
				.where(eq(organizationMigrationLinks.id, link.id));
			await tx
				.update(organizationMigrationStates)
				.set({ accessState: "diverged", updatedAt: now() })
				.where(eq(organizationMigrationStates.organizationId, orgId));
		});
		await recordMigrationActivity({
			organizationId: orgId,
			action: "migration.link-broken",
			message: "Completed migration link broken; systems may now diverge",
			entityId: link.id,
		});
		if (input.runtime.secret) {
			const sessionToken =
				link.verificationReceipt ??
				(link.encryptedSessionToken
					? await cryptography
							.decrypt(input.runtime.secret, link.encryptedSessionToken)
							.catch(() => null)
					: null);
			if (sessionToken) {
				await input.peerClient
					.notifyDiverged({
						linkId: link.id,
						apiOrigin: link.remoteApiOrigin,
						sessionToken,
					})
					.catch(() => undefined);
			}
		}
	};

	const getStatus = async (
		actorUserId: string,
		orgId?: string,
	): Promise<MigrationStatus> => {
		if (orgId) {
			const member = await input.db.query.organizationMembers.findFirst({
				where: and(
					eq(organizationMembers.organizationId, orgId),
					eq(organizationMembers.userId, actorUserId),
					isNull(organizationMembers.teamId),
				),
			});
			if (!member)
				throw new OrganizationMigrationError(
					"MIGRATION_ACCESS_DENIED",
					"Organization access denied",
					403,
				);
			const link = await input.db.query.organizationMigrationLinks.findFirst({
				where: eq(organizationMigrationLinks.localOrganizationId, orgId),
			});
			return link
				? getStatusForLink(link)
				: {
						link: null,
						run: null,
						accessState: null,
						destinationWebOrigin: null,
						verificationReceipt: null,
					};
		}
		const statuses = await listInbound(actorUserId);
		return (
			statuses[0] ?? {
				link: null,
				run: null,
				accessState: null,
				destinationWebOrigin: null,
				verificationReceipt: null,
			}
		);
	};

	const listInbound = async (
		actorUserId: string,
	): Promise<MigrationStatus[]> => {
		const codes = await input.db
			.select({ linkId: migrationReceiverCodes.linkId })
			.from(migrationReceiverCodes)
			.where(
				and(
					eq(migrationReceiverCodes.createdByUserId, actorUserId),
					ne(migrationReceiverCodes.linkId, ""),
				),
			);
		const linkIds = codes.flatMap((code) => (code.linkId ? [code.linkId] : []));
		if (linkIds.length === 0) return [];
		const links = await input.db
			.select()
			.from(organizationMigrationLinks)
			.where(inArray(organizationMigrationLinks.id, linkIds));
		return Promise.all(links.map(getStatusForLink));
	};

	const revokeReceiverCode = async (
		actorUserId: string,
		codeId: string,
	): Promise<void> => {
		const [revoked] = await input.db
			.update(migrationReceiverCodes)
			.set({ revokedAt: now() })
			.where(
				and(
					eq(migrationReceiverCodes.id, codeId),
					eq(migrationReceiverCodes.createdByUserId, actorUserId),
					isNull(migrationReceiverCodes.redeemedAt),
					isNull(migrationReceiverCodes.revokedAt),
				),
			)
			.returning();
		if (!revoked)
			throw new OrganizationMigrationError(
				"MIGRATION_RECEIVER_CODE_NOT_FOUND",
				"Receiver code not found",
				404,
			);
	};

	const acceptHandshake = async (handshake: MigrationHandshakeRequest) => {
		await assertReceiverReady();
		const codeId = /^jl_mig_([0-9a-f-]{36})\./i.exec(handshake.passphrase)?.[1];
		const passphraseHash = await cryptography.sha256(handshake.passphrase);
		const code = codeId
			? await input.db.query.migrationReceiverCodes.findFirst({
					where: eq(migrationReceiverCodes.id, codeId),
				})
			: null;
		if (
			!code ||
			code.passphraseHash !== passphraseHash ||
			code.redeemedAt ||
			code.revokedAt ||
			code.expiresAt <= now() ||
			code.failedAttempts >= 5
		) {
			if (code && !code.redeemedAt && !code.revokedAt) {
				await input.db
					.update(migrationReceiverCodes)
					.set({ failedAttempts: code.failedAttempts + 1 })
					.where(eq(migrationReceiverCodes.id, code.id));
			}
			throw new OrganizationMigrationError(
				"MIGRATION_RECEIVER_CODE_INVALID",
				"Receiver code is invalid, expired, or already used",
				401,
			);
		}
		const instanceId = await getInstanceId();
		if (handshake.sourceInstanceId === instanceId) {
			throw new OrganizationMigrationError(
				"MIGRATION_SAME_INSTANCE",
				"Source and destination must differ",
				409,
			);
		}
		if (
			protocolMajor(handshake.protocolVersion) !==
			protocolMajor(MIGRATION_PROTOCOL_VERSION)
		) {
			throw new OrganizationMigrationError(
				"MIGRATION_PROTOCOL_INCOMPATIBLE",
				"Protocol major version is incompatible",
				409,
			);
		}
		const creator = await input.db.query.users.findFirst({
			where: eq(users.id, code.createdByUserId),
		});
		if (!creator)
			throw new OrganizationMigrationError(
				"MIGRATION_RECEIVER_OWNER_MISSING",
				"Receiver operator is missing",
				409,
			);
		const creatorProfile = await input.clerkDirectory.exportProfile(
			creator.clerkUserId,
		);
		if (!creatorProfile.verifiedPrimaryEmail) {
			throw new OrganizationMigrationError(
				"MIGRATION_RECEIVER_EMAIL_REQUIRED",
				"Receiver operator needs a verified primary email",
				409,
			);
		}
		const creatorProof = await createMigrationEmailProof(
			cryptography,
			handshake.passphrase,
			creatorProfile.verifiedPrimaryEmail,
		);
		const expectedOperatorProof = await cryptography.hmac(
			handshake.passphrase,
			`${handshake.sourceInstanceId}:${handshake.sourceOrganizationId}:${[
				...handshake.operatorEmailHints,
			]
				.sort()
				.join(":")}`,
		);
		if (
			!handshake.operatorEmailHints.includes(creatorProof) ||
			handshake.operatorProof !== expectedOperatorProof
		) {
			await input.db
				.update(migrationReceiverCodes)
				.set({ failedAttempts: code.failedAttempts + 1 })
				.where(eq(migrationReceiverCodes.id, code.id));
			throw new OrganizationMigrationError(
				"MIGRATION_ADMIN_EMAIL_MISMATCH",
				"Receiver operator is not a source organization admin",
				403,
			);
		}
		let dataKey: string;
		try {
			dataKey = await cryptography.decrypt(
				handshake.passphrase,
				handshake.encryptedLinkKey,
			);
			if (fromBase64Url(dataKey).byteLength !== 32)
				throw new Error("invalid key");
		} catch {
			await input.db
				.update(migrationReceiverCodes)
				.set({ failedAttempts: code.failedAttempts + 1 })
				.where(eq(migrationReceiverCodes.id, code.id));
			throw new OrganizationMigrationError(
				"MIGRATION_HANDSHAKE_PROOF_INVALID",
				"Migration handshake proof is invalid",
				401,
			);
		}
		const sessionToken = toBase64Url(cryptography.randomBytes(32));
		const createdAt = now();
		const result = await input.db.transaction(async (tx) => {
			const [destination] = await tx
				.insert(organizations)
				.values({
					name: handshake.sourceOrganizationName,
					isPersonal: false,
					personalOwnerUserId: null,
					createdAt,
					updatedAt: createdAt,
				})
				.returning();
			if (!destination)
				throw new Error("Destination organization was not created");
			await ensureDefaultOrganizationRoles(tx, destination.id);
			await tx.insert(organizationMembers).values({
				organizationId: destination.id,
				userId: creator.id,
				role: "admin",
				createdAt,
			});
			const [link] = await tx
				.insert(organizationMigrationLinks)
				.values({
					direction: "inbound",
					localOrganizationId: destination.id,
					remoteOrganizationId: handshake.sourceOrganizationId,
					remoteInstanceId: handshake.sourceInstanceId,
					remoteApiOrigin: handshake.sourceApiOrigin,
					remoteWebOrigin: handshake.sourceWebOrigin,
					protocolVersion: handshake.protocolVersion,
					encryptedSessionToken: await cryptography.encrypt(
						input.runtime.secret as string,
						sessionToken,
					),
					encryptedDataKey: await cryptography.encrypt(
						input.runtime.secret as string,
						dataKey,
					),
					sessionTokenHash: await cryptography.sha256(sessionToken),
					createdAt,
					updatedAt: createdAt,
				})
				.returning();
			if (!link) throw new Error("Inbound migration link was not created");
			await tx.insert(organizationMigrationStates).values({
				organizationId: destination.id,
				linkId: link.id,
				role: "target",
				accessState: "importing",
				createdAt,
				updatedAt: createdAt,
			});
			await tx
				.update(migrationReceiverCodes)
				.set({ redeemedAt: createdAt, linkId: link.id })
				.where(eq(migrationReceiverCodes.id, code.id));
			return { link, destination };
		});
		await recordMigrationActivity({
			organizationId: result.destination.id,
			actorUserId: creator.id,
			action: "migration.receiving-paired",
			message: "Inbound organization migration paired",
			entityId: result.link.id,
		});
		return {
			linkId: result.link.id,
			destinationInstanceId: instanceId,
			destinationOrganizationId: result.destination.id,
			destinationWebOrigin: input.runtime.webAppOrigin as string,
			protocolVersion: MIGRATION_PROTOCOL_VERSION,
			sessionToken,
		};
	};

	const authenticateInbound = async (linkId: string, sessionToken: string) => {
		const link = await input.db.query.organizationMigrationLinks.findFirst({
			where: and(
				eq(organizationMigrationLinks.id, linkId),
				eq(organizationMigrationLinks.direction, "inbound"),
			),
		});
		const receiptAuthenticated =
			Boolean(link?.verificationReceipt) &&
			sessionToken === link?.verificationReceipt &&
			link?.state === "completed";
		if (
			!link ||
			(!receiptAuthenticated &&
				(!link.sessionTokenHash ||
					(await cryptography.sha256(sessionToken)) !== link.sessionTokenHash))
		) {
			throw new OrganizationMigrationError(
				"MIGRATION_PEER_UNAUTHORIZED",
				"Migration link authentication failed",
				401,
			);
		}
		if (["broken", "diverged"].includes(link.state)) {
			throw new OrganizationMigrationError(
				"MIGRATION_LINK_DIVERGED",
				"This migration link cannot accept more writes",
				409,
			);
		}
		return link;
	};

	const openInboundRun: OrganizationMigrationService["openInboundRun"] = async (
		linkId,
		sessionToken,
		request,
	) => {
		const link = await authenticateInbound(linkId, sessionToken);
		const existing = await input.db.query.organizationMigrationRuns.findFirst({
			where: and(
				eq(organizationMigrationRuns.linkId, linkId),
				eq(organizationMigrationRuns.sourceRunId, request.sourceRunId),
			),
		});
		const verifiedHashes = (
			await input.db
				.select({ hash: migrationEntityMappings.lastImportedHash })
				.from(migrationEntityMappings)
				.where(eq(migrationEntityMappings.linkId, linkId))
		).map((item) => item.hash);
		if (existing) {
			if (
				existing.kind !== request.kind ||
				existing.manifestHash !== request.manifestHash
			) {
				throw new OrganizationMigrationError(
					"MIGRATION_IDEMPOTENCY_CONFLICT",
					"Source run ID was already used with different content",
					409,
				);
			}
			if (existing.status === "failed" && request.override) {
				await input.db
					.update(organizationMigrationRuns)
					.set({
						status: "waiting_peer",
						override: true,
						errorCode: null,
						errorMessage: null,
						updatedAt: now(),
					})
					.where(eq(organizationMigrationRuns.id, existing.id));
			}
			return { runId: existing.id, verifiedHashes };
		}
		const active = await input.db.query.organizationMigrationRuns.findFirst({
			where: and(
				eq(organizationMigrationRuns.linkId, linkId),
				inArray(organizationMigrationRuns.status, [...ACTIVE_RUN_STATUSES]),
			),
		});
		if (active) {
			throw new OrganizationMigrationError(
				"MIGRATION_INBOUND_RUN_ACTIVE",
				"Another inbound run is active for this link",
				409,
			);
		}
		const createdAt = now();
		const [run] = await input.db
			.insert(organizationMigrationRuns)
			.values({
				linkId,
				organizationId: link.localOrganizationId,
				sourceRunId: request.sourceRunId,
				kind: request.kind,
				status: "waiting_peer",
				stage: "manifest",
				override: request.override,
				manifestHash: request.manifestHash,
				createdAt,
				updatedAt: createdAt,
			})
			.returning();
		if (!run) throw new Error("Inbound run was not created");
		return { runId: run.id, verifiedHashes };
	};

	const requireInboundRun = async (
		linkId: string,
		sessionToken: string,
		runId: string,
	) => {
		const link = await authenticateInbound(linkId, sessionToken);
		const run = await input.db.query.organizationMigrationRuns.findFirst({
			where: and(
				eq(organizationMigrationRuns.id, runId),
				eq(organizationMigrationRuns.linkId, linkId),
			),
		});
		if (!run) {
			throw new OrganizationMigrationError(
				"MIGRATION_RUN_NOT_FOUND",
				"Inbound migration run was not found",
				404,
			);
		}
		return { link, run };
	};

	const putInboundManifestPage: OrganizationMigrationService["putInboundManifestPage"] =
		async (linkId, sessionToken, runId, page, request) => {
			await requireInboundRun(linkId, sessionToken, runId);
			if (request.entries.length > 100) {
				throw new OrganizationMigrationError(
					"MIGRATION_PAGE_TOO_LARGE",
					"Manifest pages contain at most 100 entries",
					413,
				);
			}
			if ((await canonicalHash(request.entries)) !== request.contentHash) {
				throw new OrganizationMigrationError(
					"MIGRATION_PAGE_CHECKSUM_MISMATCH",
					"Manifest page checksum does not match its contents",
					422,
				);
			}
			const sourceId = `page:${page}`;
			const existing =
				await input.db.query.organizationMigrationItems.findFirst({
					where: and(
						eq(organizationMigrationItems.runId, runId),
						eq(organizationMigrationItems.kind, "manifest"),
						eq(organizationMigrationItems.sourceId, sourceId),
					),
				});
			if (existing) {
				if (existing.contentHash !== request.contentHash) {
					throw new OrganizationMigrationError(
						"MIGRATION_IDEMPOTENCY_CONFLICT",
						"Manifest page was already uploaded with different content",
						409,
					);
				}
				return;
			}
			await input.db.insert(organizationMigrationItems).values({
				runId,
				kind: "manifest",
				page,
				ordinal: page,
				sourceId,
				contentHash: request.contentHash,
				stagedPayload: JSON.stringify({
					entries: request.entries,
					isLast: request.isLast,
				}),
				status: "verified",
			});
		};

	const putInboundRecordPage: OrganizationMigrationService["putInboundRecordPage"] =
		async (linkId, sessionToken, runId, page, request) => {
			const { link } = await requireInboundRun(linkId, sessionToken, runId);
			if (request.records.length > 100) {
				throw new OrganizationMigrationError(
					"MIGRATION_PAGE_TOO_LARGE",
					"Record pages contain at most 100 records",
					413,
				);
			}
			if (!input.runtime.secret || !link.encryptedDataKey) {
				throw new OrganizationMigrationError(
					"MIGRATION_CREDENTIALS_MISSING",
					"Link data key is unavailable",
					409,
				);
			}
			const dataKey = await cryptography.decrypt(
				input.runtime.secret,
				link.encryptedDataKey,
			);
			for (let ordinal = 0; ordinal < request.records.length; ordinal += 1) {
				const record = request.records[ordinal];
				if (!record) continue;
				let hashPayload = record.payload;
				if (
					(record.entityType === "automation_api_token" ||
						record.entityType === "ai_access_token") &&
					typeof record.payload.tokenSecret === "string"
				) {
					hashPayload = {
						...record.payload,
						tokenSecret: await cryptography.decrypt(
							dataKey,
							record.payload.tokenSecret,
						),
					};
				}
				if ((await canonicalHash(hashPayload)) !== record.contentHash) {
					throw new OrganizationMigrationError(
						"MIGRATION_RECORD_CHECKSUM_MISMATCH",
						`Record checksum mismatch for ${record.entityType}:${record.sourceId}`,
						422,
					);
				}
				const sourceId = `${record.entityType}:${record.sourceId}`;
				const existing =
					await input.db.query.organizationMigrationItems.findFirst({
						where: and(
							eq(organizationMigrationItems.runId, runId),
							eq(organizationMigrationItems.kind, "record"),
							eq(organizationMigrationItems.sourceId, sourceId),
						),
					});
				if (existing && existing.contentHash !== record.contentHash) {
					throw new OrganizationMigrationError(
						"MIGRATION_IDEMPOTENCY_CONFLICT",
						"Record was already uploaded with different content",
						409,
					);
				}
				if (!existing) {
					await input.db.insert(organizationMigrationItems).values({
						runId,
						kind: "record",
						page,
						ordinal: page * 100 + ordinal,
						entityType: record.entityType,
						sourceId,
						contentHash: record.contentHash,
						stagedPayload: JSON.stringify(record),
						status: "verified",
					});
				}
			}
		};

	const putInboundArtifact: OrganizationMigrationService["putInboundArtifact"] =
		async (linkId, sessionToken, runId, artifactId, request) => {
			await requireInboundRun(linkId, sessionToken, runId);
			if (
				request.size > 100 * 1024 * 1024 ||
				request.body.byteLength !== request.size
			) {
				throw new OrganizationMigrationError(
					"MIGRATION_ARTIFACT_SIZE_INVALID",
					"Artifact size is invalid or exceeds the 100 MB transfer limit",
					413,
				);
			}
			if ((await cryptography.sha256(request.body)) !== request.contentHash) {
				throw new OrganizationMigrationError(
					"MIGRATION_ARTIFACT_CHECKSUM_MISMATCH",
					"Artifact checksum does not match the uploaded bytes",
					422,
				);
			}
			const existing =
				await input.db.query.organizationMigrationItems.findFirst({
					where: and(
						eq(organizationMigrationItems.runId, runId),
						eq(organizationMigrationItems.kind, "artifact"),
						eq(organizationMigrationItems.sourceId, artifactId),
					),
				});
			if (existing) {
				if (existing.contentHash !== request.contentHash) {
					throw new OrganizationMigrationError(
						"MIGRATION_IDEMPOTENCY_CONFLICT",
						"Artifact was already uploaded with different bytes",
						409,
					);
				}
				return;
			}
			const stagedObjectKey = `migrations/${linkId}/${artifactId}/${request.contentHash}`;
			await input.artifactStorage.putObject({
				key: stagedObjectKey,
				body: request.body,
				contentType: request.contentType,
				checksumSha256: request.contentHash,
			});
			await input.db.insert(organizationMigrationItems).values({
				runId,
				kind: "artifact",
				ordinal: 0,
				sourceId: artifactId,
				contentHash: request.contentHash,
				byteSize: request.size,
				mimeType: request.contentType,
				stagedObjectKey,
				status: "verified",
			});
		};

	const commitInboundRun: OrganizationMigrationService["commitInboundRun"] =
		async (linkId, sessionToken, runId, request) => {
			const { run } = await requireInboundRun(linkId, sessionToken, runId);
			if (run.status === "succeeded") {
				return {
					status: "succeeded",
					...(run.kind === "final" && run.errorMessage
						? { receipt: run.errorMessage }
						: {}),
				};
			}
			if (run.status === "failed") {
				return {
					status: "failed",
					errorCode: run.errorCode ?? "MIGRATION_IMPORT_FAILED",
					errorMessage: run.errorMessage ?? "Destination import failed",
				};
			}
			const items = await input.db
				.select()
				.from(organizationMigrationItems)
				.where(eq(organizationMigrationItems.runId, runId));
			const pages = items
				.filter((item) => item.kind === "manifest")
				.sort((left, right) => (left.page ?? 0) - (right.page ?? 0));
			const entries: MigrationManifestEntry[] = [];
			for (const page of pages) {
				const parsed = JSON.parse(page.stagedPayload ?? "{}") as {
					entries?: MigrationManifestEntry[];
					isLast?: boolean;
				};
				entries.push(...(parsed.entries ?? []));
			}
			const root = await orderedManifestHash(entries);
			if (root !== request.manifestHash || root !== run.manifestHash) {
				throw new OrganizationMigrationError(
					"MIGRATION_MANIFEST_CHECKSUM_MISMATCH",
					"Root manifest checksum does not match",
					422,
				);
			}
			const recordItems = new Map(
				items
					.filter((item) => item.kind === "record")
					.map((item) => [item.sourceId, item.contentHash] as const),
			);
			const artifactItems = new Map(
				items
					.filter((item) => item.kind === "artifact")
					.map((item) => [item.sourceId, item.contentHash] as const),
			);
			const mapped = new Map(
				(
					await input.db
						.select()
						.from(migrationEntityMappings)
						.where(eq(migrationEntityMappings.linkId, linkId))
				).map(
					(item) =>
						[
							`${item.entityType}:${item.sourceEntityId}`,
							item.lastImportedHash,
						] as const,
				),
			);
			for (const entry of entries) {
				const received =
					entry.kind === "record"
						? recordItems.get(`${entry.entityType}:${entry.sourceId}`)
						: artifactItems.get(entry.sourceId);
				const previous = mapped.get(`${entry.entityType}:${entry.sourceId}`);
				if (received !== entry.contentHash && previous !== entry.contentHash) {
					throw new OrganizationMigrationError(
						"MIGRATION_ITEM_MISSING",
						`Manifest item is missing: ${entry.entityType}:${entry.sourceId}`,
						422,
					);
				}
			}
			if (
				entries.filter((entry) => entry.kind === "record").length !==
					request.recordCount ||
				entries.filter((entry) => entry.kind === "artifact").length !==
					request.artifactCount ||
				entries
					.filter((entry) => entry.kind === "artifact")
					.reduce((sum, entry) => sum + (entry.byteSize ?? 0), 0) !==
					request.totalBytes
			) {
				throw new OrganizationMigrationError(
					"MIGRATION_COUNT_MISMATCH",
					"Manifest counts or byte totals do not match the commit",
					422,
				);
			}
			await input.db
				.update(organizationMigrationRuns)
				.set({
					status: "queued",
					stage: "verify",
					recordTotal: request.recordCount,
					artifactTotal: request.artifactCount,
					bytesTotal: request.totalBytes,
					updatedAt: now(),
				})
				.where(eq(organizationMigrationRuns.id, runId));
			return { status: "queued" };
		};

	const getInboundRun: OrganizationMigrationService["getInboundRun"] = async (
		linkId,
		sessionToken,
		runId,
	) => {
		const { run } = await requireInboundRun(linkId, sessionToken, runId);
		return toRun(run);
	};

	const finalizeInbound: OrganizationMigrationService["finalizeInbound"] =
		async (linkId, sessionToken, receipt) => {
			const link = await authenticateInbound(linkId, sessionToken).catch(() =>
				authenticateInbound(linkId, receipt),
			);
			if (!link.localOrganizationId || link.verificationReceipt !== receipt) {
				throw new OrganizationMigrationError(
					"MIGRATION_RECEIPT_INVALID",
					"Final verification receipt is invalid",
					422,
				);
			}
			const completedRunIds = (
				await input.db.query.organizationMigrationRuns.findMany({
					where: and(
						eq(organizationMigrationRuns.linkId, linkId),
						eq(organizationMigrationRuns.status, "succeeded"),
					),
					columns: { id: true },
				})
			).map((run) => run.id);
			await input.db.transaction(async (tx) => {
				await tx
					.update(organizationMigrationStates)
					.set({ accessState: "writable", updatedAt: now() })
					.where(
						eq(
							organizationMigrationStates.organizationId,
							link.localOrganizationId as string,
						),
					);
				await tx
					.update(organizationMigrationLinks)
					.set({
						state: "completed",
						encryptedSessionToken: null,
						encryptedDataKey: null,
						sessionTokenHash: null,
						credentialsWipedAt: now(),
						updatedAt: now(),
					})
					.where(eq(organizationMigrationLinks.id, linkId));
				if (completedRunIds.length > 0) {
					await tx
						.update(organizationMigrationItems)
						.set({
							stagedPayload: null,
							stagedObjectKey: null,
							updatedAt: now(),
						})
						.where(inArray(organizationMigrationItems.runId, completedRunIds));
				}
			});
		};

	const markInboundDiverged: OrganizationMigrationService["markInboundDiverged"] =
		async (linkId, sessionToken) => {
			const link = await authenticateInbound(linkId, sessionToken);
			if (!link.localOrganizationId) return;
			await input.db.transaction(async (tx) => {
				await tx
					.update(organizationMigrationLinks)
					.set({ state: "diverged", updatedAt: now() })
					.where(eq(organizationMigrationLinks.id, linkId));
				await tx
					.update(organizationMigrationStates)
					.set({ accessState: "diverged", updatedAt: now() })
					.where(
						eq(
							organizationMigrationStates.organizationId,
							link.localOrganizationId as string,
						),
					);
			});
		};

	type SourceArtifact = {
		id: string;
		storageKey: string;
		contentHash: string;
		contentType: string;
		size: number;
	};
	type SourceSnapshot = {
		records: MigrationRecord[];
		artifacts: SourceArtifact[];
		manifest: MigrationManifestEntry[];
		manifestHash: string;
	};

	const scanSourceOrganization = async (
		organizationId: string,
	): Promise<SourceSnapshot> => {
		const organization = await input.db.query.organizations.findFirst({
			where: eq(organizations.id, organizationId),
		});
		if (!organization) {
			throw new MigrationWorkerError(
				"SOURCE_ORGANIZATION_MISSING",
				"Source organization no longer exists",
			);
		}
		const [
			members,
			roles,
			evidenceRows,
			tags,
			recordings,
			links,
			invitations,
			invitationCodes,
			joinRequests,
			activity,
			automationTokens,
		] = await Promise.all([
			input.db
				.select()
				.from(organizationMembers)
				.where(eq(organizationMembers.organizationId, organizationId)),
			input.db
				.select()
				.from(organizationRoles)
				.where(eq(organizationRoles.organizationId, organizationId)),
			input.db
				.select()
				.from(evidences)
				.where(eq(evidences.orgId, organizationId)),
			input.db
				.select()
				.from(organizationEvidenceTags)
				.where(eq(organizationEvidenceTags.orgId, organizationId)),
			input.db
				.select()
				.from(desktopRecordingSessions)
				.where(eq(desktopRecordingSessions.orgId, organizationId)),
			input.db
				.select()
				.from(shareLinks)
				.where(eq(shareLinks.orgId, organizationId)),
			input.db
				.select()
				.from(organizationInvitations)
				.where(eq(organizationInvitations.organizationId, organizationId)),
			input.db
				.select()
				.from(organizationInvitationCodes)
				.where(eq(organizationInvitationCodes.organizationId, organizationId)),
			input.db
				.select()
				.from(organizationJoinRequests)
				.where(eq(organizationJoinRequests.organizationId, organizationId)),
			input.db
				.select()
				.from(organizationActivityLogs)
				.where(eq(organizationActivityLogs.organizationId, organizationId)),
			input.db
				.select()
				.from(automationApiTokens)
				.where(eq(automationApiTokens.orgId, organizationId)),
		]);
		const evidenceIds = evidenceRows.map((row) => row.id);
		const [artifactRows, comments, assignments, usageLogs] =
			evidenceIds.length === 0
				? [[], [], [], []]
				: await Promise.all([
						input.db
							.select()
							.from(evidenceArtifacts)
							.where(inArray(evidenceArtifacts.evidenceId, evidenceIds)),
						input.db
							.select()
							.from(evidenceComments)
							.where(inArray(evidenceComments.evidenceId, evidenceIds)),
						input.db
							.select()
							.from(evidenceTagAssignments)
							.where(inArray(evidenceTagAssignments.evidenceId, evidenceIds)),
						input.db
							.select()
							.from(aiAccessTokenUsageLogs)
							.where(inArray(aiAccessTokenUsageLogs.evidenceId, evidenceIds)),
					]);
		const principalIds = new Set<string>();
		for (const row of members) principalIds.add(row.userId);
		for (const row of evidenceRows) principalIds.add(row.createdBy);
		for (const row of comments) principalIds.add(row.createdBy);
		for (const row of assignments)
			if (row.assignedBy) principalIds.add(row.assignedBy);
		for (const row of recordings) principalIds.add(row.createdBy);
		for (const row of links) principalIds.add(row.createdBy);
		for (const row of invitations) {
			principalIds.add(row.invitedBy);
			if (row.acceptedBy) principalIds.add(row.acceptedBy);
		}
		for (const row of invitationCodes) principalIds.add(row.createdBy);
		for (const row of joinRequests) {
			principalIds.add(row.userId);
			if (row.reviewedBy) principalIds.add(row.reviewedBy);
		}
		for (const row of activity)
			if (row.actorUserId) principalIds.add(row.actorUserId);
		for (const row of automationTokens) principalIds.add(row.userId);
		for (const row of usageLogs) principalIds.add(row.userId);
		const userRows =
			principalIds.size > 0
				? await input.db
						.select()
						.from(users)
						.where(inArray(users.id, [...principalIds]))
				: [];
		const currentMemberIds = new Set(members.map((member) => member.userId));
		const identityPayloads = await Promise.all(
			userRows.map(async (user) => {
				let profile: Awaited<
					ReturnType<ClerkDirectory["exportProfile"]>
				> | null = null;
				try {
					profile = await input.clerkDirectory.exportProfile(user.clerkUserId);
				} catch (error) {
					if (currentMemberIds.has(user.id)) {
						throw new MigrationWorkerError(
							"CLERK_DIRECTORY_UNAVAILABLE",
							error instanceof Error
								? error.message
								: "Clerk profile export failed",
							true,
						);
					}
				}
				if (currentMemberIds.has(user.id) && !profile?.verifiedPrimaryEmail) {
					throw new MigrationWorkerError(
						"IDENTITY_EMAIL_MISSING",
						`A current member does not have a verified primary email (${user.id})`,
					);
				}
				return {
					id: user.id,
					clerkUserId: user.clerkUserId,
					createdAt: user.createdAt,
					updatedAt: user.updatedAt,
					activeMember: currentMemberIds.has(user.id),
					profile,
				};
			}),
		);
		const aiTokens =
			currentMemberIds.size > 0
				? await input.db
						.select()
						.from(aiAccessTokens)
						.where(inArray(aiAccessTokens.userId, [...currentMemberIds]))
				: [];

		const rawRecords: Array<{
			entityType: string;
			sourceId: string;
			payload: Record<string, unknown>;
		}> = [];
		const add = (
			entityType: string,
			rows: readonly Record<string, unknown>[],
			idKey = "id",
		) => {
			for (const row of rows) {
				const sourceId = row[idKey];
				if (typeof sourceId !== "string") {
					throw new MigrationWorkerError(
						"SOURCE_RECORD_INVALID",
						`${entityType} is missing a stable ID`,
					);
				}
				rawRecords.push({ entityType, sourceId, payload: { ...row } });
			}
		};
		add("organization", [organization]);
		add("identity", identityPayloads);
		add("organization_role", roles);
		add("organization_member", members);
		add("evidence", evidenceRows);
		add(
			"evidence_artifact",
			artifactRows.map(({ s3Key: _s3Key, ...row }) => row),
		);
		add("evidence_comment", comments);
		add("evidence_tag", tags);
		add(
			"evidence_tag_assignment",
			assignments.map((row) => ({
				...row,
				id: `${row.evidenceId}:${row.tagId}`,
			})),
		);
		add("desktop_recording_session", recordings);
		add("share_link", links);
		add("organization_invitation", invitations);
		add("organization_invitation_code", invitationCodes);
		add("organization_join_request", joinRequests);
		// Migration lifecycle events are bookkeeping for the authoritative source,
		// not organization content. Excluding them also keeps retry manifests stable.
		add(
			"organization_activity",
			activity.filter((row) => !row.action.startsWith("migration.")),
		);
		add("automation_api_token", automationTokens);
		add("ai_access_token", aiTokens);
		add("ai_access_token_usage", usageLogs);
		const records: MigrationRecord[] = await Promise.all(
			rawRecords.map(async (record) => ({
				...record,
				contentHash: await canonicalHash(record.payload),
			})),
		);
		const artifacts: SourceArtifact[] = artifactRows
			.filter((row) => row.uploadStatus === "uploaded")
			.map((row) => ({
				id: row.id,
				storageKey: row.s3Key,
				contentHash: row.checksum.toLowerCase(),
				contentType: row.mimeType,
				size: row.bytes,
			}));
		const manifest: MigrationManifestEntry[] = [
			...records.map((record) => ({
				kind: "record" as const,
				entityType: record.entityType,
				sourceId: record.sourceId,
				contentHash: record.contentHash,
			})),
			...artifacts.map((artifact) => ({
				kind: "artifact" as const,
				entityType: "artifact_bytes",
				sourceId: artifact.id,
				contentHash: artifact.contentHash,
				byteSize: artifact.size,
			})),
		];
		return {
			records,
			artifacts,
			manifest,
			manifestHash: await orderedManifestHash(manifest),
		};
	};

	const processInboundPublication = async (
		run: ClaimedMigrationRun,
		link: typeof organizationMigrationLinks.$inferSelect,
		controls: Parameters<MigrationRunHandler>[1],
	): Promise<"succeeded"> => {
		if (
			!run.organizationId ||
			!input.runtime.secret ||
			!link.encryptedDataKey
		) {
			throw new MigrationWorkerError(
				"INBOUND_MIGRATION_CONTEXT_MISSING",
				"Inbound migration context or credentials are unavailable",
			);
		}
		const destinationOrganizationId = run.organizationId;
		const items = await input.db
			.select()
			.from(organizationMigrationItems)
			.where(eq(organizationMigrationItems.runId, run.id));
		const records = items
			.filter(
				(item) =>
					item.kind === "record" &&
					item.stagedPayload &&
					item.status === "verified",
			)
			.map((item) => ({
				item,
				record: JSON.parse(item.stagedPayload as string) as MigrationRecord,
			}));
		const manifestEntries = items
			.filter((item) => item.kind === "manifest" && item.stagedPayload)
			.sort((left, right) => (left.page ?? 0) - (right.page ?? 0))
			.flatMap((item) => {
				const page = JSON.parse(item.stagedPayload as string) as {
					entries?: MigrationManifestEntry[];
				};
				return page.entries ?? [];
			});
		const dataKey = await cryptography.decrypt(
			input.runtime.secret,
			link.encryptedDataKey,
		);

		await controls.checkpoint("identities");
		for (const { item, record } of records.filter(
			(entry) => entry.record.entityType === "identity",
		)) {
			const existing = await input.db.query.migrationIdentityMappings.findFirst(
				{
					where: and(
						eq(migrationIdentityMappings.linkId, link.id),
						eq(migrationIdentityMappings.sourceLocalUserId, record.sourceId),
					),
				},
			);
			if (!existing) {
				const payload = record.payload as {
					clerkUserId: string;
					activeMember: boolean;
					createdAt: number;
					profile: {
						verifiedPrimaryEmail: string | null;
						firstName: string | null;
						lastName: string | null;
						username: string | null;
						imageUrl: string | null;
						createdAt: number;
					} | null;
				};
				let destinationClerkUserId: string;
				let archivedPrincipal = false;
				if (payload.activeMember) {
					const email = payload.profile?.verifiedPrimaryEmail;
					if (!email || !payload.profile) {
						throw new MigrationWorkerError(
							"IDENTITY_EMAIL_MISSING",
							`Current member ${record.sourceId} has no verified primary email`,
						);
					}
					let matches: Awaited<
						ReturnType<ClerkDirectory["findByVerifiedEmail"]>
					>;
					try {
						matches = await input.clerkDirectory.findByVerifiedEmail(email);
					} catch (error) {
						throw new MigrationWorkerError(
							"CLERK_DIRECTORY_UNAVAILABLE",
							error instanceof Error
								? error.message
								: "Destination Clerk lookup failed",
							true,
						);
					}
					if (matches.length > 1) {
						throw new MigrationWorkerError(
							"IDENTITY_EMAIL_AMBIGUOUS",
							`More than one destination identity matches member ${record.sourceId}`,
						);
					}
					let destinationProfile = matches[0];
					if (!destinationProfile) {
						try {
							destinationProfile = await input.clerkDirectory.createUser({
								clerkUserId: payload.clerkUserId,
								verifiedPrimaryEmail: email,
								firstName: payload.profile.firstName,
								lastName: payload.profile.lastName,
								username: payload.profile.username,
								imageUrl: payload.profile.imageUrl,
								createdAt: payload.profile.createdAt,
							});
						} catch (error) {
							throw new MigrationWorkerError(
								"CLERK_DIRECTORY_UNAVAILABLE",
								error instanceof Error
									? error.message
									: "Destination Clerk user creation failed",
								true,
							);
						}
					}
					destinationClerkUserId = destinationProfile.clerkUserId;
					if (destinationProfile.warnings?.length) {
						const currentRun =
							await input.db.query.organizationMigrationRuns.findFirst({
								where: eq(organizationMigrationRuns.id, run.id),
								columns: { warningsJson: true },
							});
						await input.db
							.update(organizationMigrationRuns)
							.set({
								warningsJson: JSON.stringify([
									...parseWarnings(currentRun?.warningsJson ?? "[]"),
									...destinationProfile.warnings,
								]),
								updatedAt: now(),
							})
							.where(eq(organizationMigrationRuns.id, run.id));
					}
				} else {
					destinationClerkUserId = `archived_migration_${link.id}_${record.sourceId}`;
					archivedPrincipal = true;
				}
				let localUser = await input.db.query.users.findFirst({
					where: eq(users.clerkUserId, destinationClerkUserId),
				});
				if (!localUser) {
					[localUser] = await input.db
						.insert(users)
						.values({
							clerkUserId: destinationClerkUserId,
							activeOrgId: payload.activeMember
								? destinationOrganizationId
								: null,
							createdAt: payload.createdAt,
							updatedAt: now(),
						})
						.returning();
				}
				if (!localUser)
					throw new Error("Destination local identity was not created");
				await input.db.insert(migrationIdentityMappings).values({
					linkId: link.id,
					sourceLocalUserId: record.sourceId,
					sourceClerkUserId: payload.clerkUserId,
					destinationLocalUserId: localUser.id,
					destinationClerkUserId,
					archivedPrincipal,
				});
			}
			await input.db
				.update(organizationMigrationItems)
				.set({ status: "published", updatedAt: now() })
				.where(eq(organizationMigrationItems.id, item.id));
		}
		const identityMappings = await input.db
			.select()
			.from(migrationIdentityMappings)
			.where(eq(migrationIdentityMappings.linkId, link.id));
		const userMap = new Map(
			identityMappings.map((mapping) => [
				mapping.sourceLocalUserId,
				mapping.destinationLocalUserId,
			]),
		);
		const sourceUserByDestination = new Map(
			identityMappings.map((mapping) => [
				mapping.destinationLocalUserId,
				mapping.sourceLocalUserId,
			]),
		);
		const targetUser = (sourceId: string | null): string | null => {
			if (!sourceId) return null;
			const mapped = userMap.get(sourceId);
			if (!mapped) {
				throw new MigrationWorkerError(
					"IDENTITY_MAPPING_MISSING",
					`No destination identity mapping exists for ${sourceId}`,
				);
			}
			return mapped;
		};

		const existingMappings = await input.db
			.select()
			.from(migrationEntityMappings)
			.where(eq(migrationEntityMappings.linkId, link.id));
		const entityMap = new Map(
			existingMappings.map((mapping) => [
				`${mapping.entityType}:${mapping.sourceEntityId}`,
				mapping.destinationEntityId,
			]),
		);
		const sourceEntityByDestination = new Map(
			existingMappings.map((mapping) => [
				`${mapping.entityType}:${mapping.destinationEntityId}`,
				mapping.sourceEntityId,
			]),
		);
		const ownedBefore = new Set(
			existingMappings.map(
				(mapping) => `${mapping.entityType}:${mapping.sourceEntityId}`,
			),
		);
		const targetEntity = (
			entityType: string,
			sourceId: string | null,
			preserve = false,
		): string | null => {
			if (!sourceId) return null;
			const key = `${entityType}:${sourceId}`;
			const existing = entityMap.get(key);
			if (existing) return existing;
			const destinationId = preserve ? sourceId : crypto.randomUUID();
			entityMap.set(key, destinationId);
			return destinationId;
		};
		const verifyOwnedTarget = async (
			record: MigrationRecord,
		): Promise<void> => {
			const mapping = existingMappings.find(
				(candidate) =>
					candidate.entityType === record.entityType &&
					candidate.sourceEntityId === record.sourceId,
			);
			if (!mapping || mapping.lastImportedHash === record.contentHash) return;
			let currentPayload: Record<string, unknown> | null = null;
			switch (record.entityType) {
				case "organization": {
					const current = await input.db.query.organizations.findFirst({
						where: eq(organizations.id, mapping.destinationEntityId),
					});
					if (current) currentPayload = { ...current, id: record.sourceId };
					break;
				}
				case "evidence": {
					const current = await input.db.query.evidences.findFirst({
						where: eq(evidences.id, mapping.destinationEntityId),
					});
					if (current) {
						currentPayload = {
							...current,
							id: record.sourceId,
							orgId: link.remoteOrganizationId,
							createdBy:
								sourceUserByDestination.get(current.createdBy) ??
								current.createdBy,
							deletedBy: current.deletedBy
								? (sourceUserByDestination.get(current.deletedBy) ??
									current.deletedBy)
								: null,
						};
					}
					break;
				}
				case "evidence_comment": {
					const current = await input.db.query.evidenceComments.findFirst({
						where: eq(evidenceComments.id, mapping.destinationEntityId),
					});
					if (current) {
						currentPayload = {
							...current,
							id: record.sourceId,
							evidenceId:
								sourceEntityByDestination.get(
									`evidence:${current.evidenceId}`,
								) ?? current.evidenceId,
							createdBy:
								sourceUserByDestination.get(current.createdBy) ??
								current.createdBy,
						};
					}
					break;
				}
				case "evidence_tag": {
					const current =
						await input.db.query.organizationEvidenceTags.findFirst({
							where: eq(
								organizationEvidenceTags.id,
								mapping.destinationEntityId,
							),
						});
					if (current) {
						currentPayload = {
							...current,
							id: record.sourceId,
							orgId: link.remoteOrganizationId,
						};
					}
					break;
				}
			}
			if (
				currentPayload &&
				(await canonicalHash(currentPayload)) !== mapping.lastImportedHash &&
				!run.override
			) {
				throw new MigrationWorkerError(
					"TARGET_DRIFT",
					`Destination ${record.entityType}:${record.sourceId} changed outside this migration`,
				);
			}
		};

		const priority = [
			"organization",
			"organization_role",
			"organization_invitation_code",
			"organization_member",
			"evidence",
			"evidence_artifact",
			"evidence_comment",
			"evidence_tag",
			"evidence_tag_assignment",
			"desktop_recording_session",
			"share_link",
			"organization_invitation",
			"organization_join_request",
			"organization_activity",
			"automation_api_token",
			"ai_access_token",
			"ai_access_token_usage",
		];
		const sorted = records
			.filter((entry) => entry.record.entityType !== "identity")
			.sort(
				(left, right) =>
					priority.indexOf(left.record.entityType) -
					priority.indexOf(right.record.entityType),
			);
		for (const { record } of sorted) await verifyOwnedTarget(record);
		if (run.kind === "final") {
			await controls.checkpoint("verify");
			const artifactItems = new Map(
				items
					.filter((item) => item.kind === "artifact")
					.map((item) => [item.sourceId, item] as const),
			);
			const artifactMappings = new Map(
				existingMappings
					.filter((mapping) => mapping.entityType === "artifact_bytes")
					.map((mapping) => [mapping.sourceEntityId, mapping] as const),
			);
			for (const artifact of manifestEntries.filter(
				(entry) => entry.kind === "artifact",
			)) {
				const item = artifactItems.get(artifact.sourceId);
				const objectKey =
					item?.stagedObjectKey ??
					artifactMappings.get(artifact.sourceId)?.destinationEntityId;
				if (!objectKey) {
					throw new MigrationWorkerError(
						"TARGET_ARTIFACT_MISSING",
						`Destination artifact ${artifact.sourceId} is missing`,
					);
				}
				const body = await input.artifactStorage.getObject({ key: objectKey });
				if (
					body.byteLength !== artifact.byteSize ||
					(await cryptography.sha256(body)) !== artifact.contentHash
				) {
					throw new MigrationWorkerError(
						"TARGET_CHECKSUM_MISMATCH",
						`Destination artifact ${artifact.sourceId} failed final verification`,
					);
				}
			}
		}
		await controls.checkpoint("publish");
		await input.db.transaction(async (tx) => {
			// This transient value is visible only inside the publication transaction.
			// It lets migration-owned writes pass the database guards while callers
			// continue to observe the previous read-only/importing state until commit.
			await tx
				.update(organizationMigrationStates)
				.set({ accessState: "writable", updatedAt: now() })
				.where(
					eq(
						organizationMigrationStates.organizationId,
						destinationOrganizationId,
					),
				);
			for (const entry of manifestEntries) {
				await tx
					.update(migrationEntityMappings)
					.set({ lastSeenRunId: run.id, updatedAt: now() })
					.where(
						and(
							eq(migrationEntityMappings.linkId, link.id),
							eq(migrationEntityMappings.entityType, entry.entityType),
							eq(migrationEntityMappings.sourceEntityId, entry.sourceId),
							eq(migrationEntityMappings.lastImportedHash, entry.contentHash),
						),
					);
			}
			for (const artifactItem of items.filter(
				(item) => item.kind === "artifact" && item.stagedObjectKey,
			)) {
				await tx
					.insert(migrationEntityMappings)
					.values({
						linkId: link.id,
						entityType: "artifact_bytes",
						sourceEntityId: artifactItem.sourceId,
						destinationEntityId: artifactItem.stagedObjectKey as string,
						lastImportedHash: artifactItem.contentHash,
						lastSeenRunId: run.id,
					})
					.onConflictDoUpdate({
						target: [
							migrationEntityMappings.linkId,
							migrationEntityMappings.entityType,
							migrationEntityMappings.sourceEntityId,
						],
						set: {
							destinationEntityId: artifactItem.stagedObjectKey as string,
							lastImportedHash: artifactItem.contentHash,
							lastSeenRunId: run.id,
							updatedAt: now(),
						},
					});
			}
			for (const { item, record } of sorted) {
				const row = { ...record.payload } as Record<string, unknown>;
				let destinationId = destinationOrganizationId;
				switch (record.entityType) {
					case "organization": {
						await tx
							.update(organizations)
							.set({
								name: String(row.name),
								requireInvitationApproval: Boolean(
									row.requireInvitationApproval,
								),
								createdAt: Number(row.createdAt),
								updatedAt: Number(row.updatedAt),
							})
							.where(eq(organizations.id, destinationOrganizationId));
						break;
					}
					case "organization_role": {
						const existing = await tx.query.organizationRoles.findFirst({
							where: and(
								eq(organizationRoles.organizationId, destinationOrganizationId),
								eq(
									organizationRoles.key,
									row.key as typeof organizationRoles.$inferSelect.key,
								),
							),
						});
						destinationId =
							existing?.id ??
							(targetEntity(record.entityType, record.sourceId) as string);
						await tx
							.insert(organizationRoles)
							.values({
								...(row as typeof organizationRoles.$inferInsert),
								id: destinationId,
								organizationId: destinationOrganizationId,
							})
							.onConflictDoUpdate({
								target: [
									organizationRoles.organizationId,
									organizationRoles.key,
								],
								set: {
									name: String(row.name),
									permissionsJson: String(row.permissionsJson),
									updatedAt: Number(row.updatedAt),
								},
							});
						entityMap.set(
							`${record.entityType}:${record.sourceId}`,
							destinationId,
						);
						break;
					}
					case "organization_member": {
						const destinationUserId = targetUser(String(row.userId)) as string;
						const existingMembership =
							await tx.query.organizationMembers.findFirst({
								where: and(
									eq(
										organizationMembers.organizationId,
										destinationOrganizationId,
									),
									eq(organizationMembers.userId, destinationUserId),
									isNull(organizationMembers.teamId),
								),
							});
						destinationId =
							existingMembership?.id ??
							(targetEntity(record.entityType, record.sourceId) as string);
						entityMap.set(
							`${record.entityType}:${record.sourceId}`,
							destinationId,
						);
						await tx
							.insert(organizationMembers)
							.values({
								...(row as typeof organizationMembers.$inferInsert),
								id: destinationId,
								organizationId: destinationOrganizationId,
								userId: destinationUserId,
								invitationCodeId: targetEntity(
									"organization_invitation_code",
									typeof row.invitationCodeId === "string"
										? row.invitationCodeId
										: null,
									true,
								),
							})
							.onConflictDoUpdate({
								target: organizationMembers.id,
								set: {
									role: row.role as typeof organizationMembers.$inferSelect.role,
									guestExpiresAt:
										typeof row.guestExpiresAt === "number"
											? row.guestExpiresAt
											: null,
								},
							});
						break;
					}
					case "evidence": {
						destinationId = targetEntity(
							record.entityType,
							record.sourceId,
						) as string;
						await tx
							.insert(evidences)
							.values({
								...(row as typeof evidences.$inferInsert),
								id: destinationId,
								orgId: destinationOrganizationId,
								createdBy: targetUser(String(row.createdBy)) as string,
								deletedBy: targetUser(
									typeof row.deletedBy === "string" ? row.deletedBy : null,
								),
							})
							.onConflictDoUpdate({
								target: evidences.id,
								set: {
									orgId: destinationOrganizationId,
									createdBy: targetUser(String(row.createdBy)) as string,
									title: String(row.title),
									sourceType: String(row.sourceType),
									sourceUri:
										typeof row.sourceUri === "string" ? row.sourceUri : null,
									sourceExternalId:
										typeof row.sourceExternalId === "string"
											? row.sourceExternalId
											: null,
									sourceMetadata:
										typeof row.sourceMetadata === "string"
											? row.sourceMetadata
											: null,
									thumbnailBase64:
										typeof row.thumbnailBase64 === "string"
											? row.thumbnailBase64
											: null,
									thumbnailMimeType:
										typeof row.thumbnailMimeType === "string"
											? row.thumbnailMimeType
											: null,
									teamId: typeof row.teamId === "string" ? row.teamId : null,
									scopeType:
										row.scopeType as typeof evidences.$inferSelect.scopeType,
									scopeId: typeof row.scopeId === "string" ? row.scopeId : null,
									updatedAt: Number(row.updatedAt),
									deletedAt:
										typeof row.deletedAt === "number" ? row.deletedAt : null,
									deletedBy: targetUser(
										typeof row.deletedBy === "string" ? row.deletedBy : null,
									),
									deletePurgesAt:
										typeof row.deletePurgesAt === "number"
											? row.deletePurgesAt
											: null,
								},
							});
						break;
					}
					case "evidence_artifact": {
						destinationId = targetEntity(
							record.entityType,
							record.sourceId,
						) as string;
						const bytesItem = items.find(
							(candidate) =>
								candidate.kind === "artifact" &&
								candidate.sourceId === record.sourceId,
						);
						const prior = await tx.query.evidenceArtifacts.findFirst({
							where: eq(evidenceArtifacts.id, destinationId),
						});
						const objectKey = bytesItem?.stagedObjectKey ?? prior?.s3Key;
						if (!objectKey) {
							throw new MigrationWorkerError(
								"MIGRATION_ARTIFACT_MISSING",
								`No verified destination object exists for ${record.sourceId}`,
							);
						}
						await tx
							.insert(evidenceArtifacts)
							.values({
								...(row as typeof evidenceArtifacts.$inferInsert),
								id: destinationId,
								evidenceId: targetEntity(
									"evidence",
									String(row.evidenceId),
								) as string,
								s3Key: objectKey,
							})
							.onConflictDoUpdate({
								target: evidenceArtifacts.id,
								set: {
									s3Key: objectKey,
									mimeType: String(row.mimeType),
									bytes: Number(row.bytes),
									checksum: String(row.checksum),
									uploadStatus:
										row.uploadStatus as typeof evidenceArtifacts.$inferSelect.uploadStatus,
									updatedAt: Number(row.updatedAt),
								},
							});
						break;
					}
					case "evidence_comment": {
						destinationId = targetEntity(
							record.entityType,
							record.sourceId,
						) as string;
						await tx
							.insert(evidenceComments)
							.values({
								...(row as typeof evidenceComments.$inferInsert),
								id: destinationId,
								evidenceId: targetEntity(
									"evidence",
									String(row.evidenceId),
								) as string,
								createdBy: targetUser(String(row.createdBy)) as string,
							})
							.onConflictDoUpdate({
								target: evidenceComments.id,
								set: {
									body: String(row.body),
									updatedAt: Number(row.updatedAt),
								},
							});
						break;
					}
					case "evidence_tag": {
						destinationId = targetEntity(
							record.entityType,
							record.sourceId,
						) as string;
						await tx
							.insert(organizationEvidenceTags)
							.values({
								...(row as typeof organizationEvidenceTags.$inferInsert),
								id: destinationId,
								orgId: destinationOrganizationId,
							})
							.onConflictDoUpdate({
								target: organizationEvidenceTags.id,
								set: {
									name: String(row.name),
									color: String(row.color),
									updatedAt: Number(row.updatedAt),
								},
							});
						break;
					}
					case "evidence_tag_assignment": {
						destinationId = `${targetEntity("evidence", String(row.evidenceId))}:${targetEntity("evidence_tag", String(row.tagId))}`;
						await tx
							.insert(evidenceTagAssignments)
							.values({
								evidenceId: targetEntity(
									"evidence",
									String(row.evidenceId),
								) as string,
								tagId: targetEntity(
									"evidence_tag",
									String(row.tagId),
								) as string,
								assignedBy: targetUser(
									typeof row.assignedBy === "string" ? row.assignedBy : null,
								),
								createdAt: Number(row.createdAt),
							})
							.onConflictDoNothing();
						break;
					}
					case "desktop_recording_session": {
						destinationId = targetEntity(
							record.entityType,
							record.sourceId,
						) as string;
						await tx
							.insert(desktopRecordingSessions)
							.values({
								...(row as typeof desktopRecordingSessions.$inferInsert),
								id: destinationId,
								evidenceId: targetEntity(
									"evidence",
									String(row.evidenceId),
								) as string,
								orgId: destinationOrganizationId,
								createdBy: targetUser(String(row.createdBy)) as string,
							})
							.onConflictDoUpdate({
								target: desktopRecordingSessions.id,
								set: {
									sourceMetadata:
										typeof row.sourceMetadata === "string"
											? row.sourceMetadata
											: null,
									updatedAt: Number(row.updatedAt),
								},
							});
						break;
					}
					case "share_link": {
						destinationId = targetEntity(
							record.entityType,
							record.sourceId,
							true,
						) as string;
						const insertion = tx.insert(shareLinks).values({
							...(row as typeof shareLinks.$inferInsert),
							id: destinationId,
							evidenceId: targetEntity(
								"evidence",
								String(row.evidenceId),
							) as string,
							orgId: destinationOrganizationId,
							createdBy: targetUser(String(row.createdBy)) as string,
						});
						if (ownedBefore.has(`${record.entityType}:${record.sourceId}`)) {
							await insertion.onConflictDoUpdate({
								target: shareLinks.id,
								set: {
									...(row as Partial<typeof shareLinks.$inferInsert>),
									evidenceId: targetEntity(
										"evidence",
										String(row.evidenceId),
									) as string,
									orgId: destinationOrganizationId,
									createdBy: targetUser(String(row.createdBy)) as string,
								},
							});
						} else await insertion;
						break;
					}
					case "organization_invitation_code": {
						destinationId = targetEntity(
							record.entityType,
							record.sourceId,
							true,
						) as string;
						const insertion = tx.insert(organizationInvitationCodes).values({
							...(row as typeof organizationInvitationCodes.$inferInsert),
							id: destinationId,
							organizationId: destinationOrganizationId,
							createdBy: targetUser(String(row.createdBy)) as string,
						});
						if (ownedBefore.has(`${record.entityType}:${record.sourceId}`)) {
							await insertion.onConflictDoUpdate({
								target: organizationInvitationCodes.id,
								set: {
									...(row as Partial<
										typeof organizationInvitationCodes.$inferInsert
									>),
									organizationId: destinationOrganizationId,
									createdBy: targetUser(String(row.createdBy)) as string,
								},
							});
						} else await insertion;
						break;
					}
					case "organization_invitation": {
						destinationId = targetEntity(
							record.entityType,
							record.sourceId,
							true,
						) as string;
						const insertion = tx.insert(organizationInvitations).values({
							...(row as typeof organizationInvitations.$inferInsert),
							id: destinationId,
							organizationId: destinationOrganizationId,
							invitedBy: targetUser(String(row.invitedBy)) as string,
							acceptedBy: targetUser(
								typeof row.acceptedBy === "string" ? row.acceptedBy : null,
							),
						});
						if (ownedBefore.has(`${record.entityType}:${record.sourceId}`)) {
							await insertion.onConflictDoUpdate({
								target: organizationInvitations.id,
								set: {
									...(row as Partial<
										typeof organizationInvitations.$inferInsert
									>),
									organizationId: destinationOrganizationId,
									invitedBy: targetUser(String(row.invitedBy)) as string,
									acceptedBy: targetUser(
										typeof row.acceptedBy === "string" ? row.acceptedBy : null,
									),
								},
							});
						} else await insertion;
						break;
					}
					case "organization_join_request": {
						destinationId = targetEntity(
							record.entityType,
							record.sourceId,
							true,
						) as string;
						const insertion = tx.insert(organizationJoinRequests).values({
							...(row as typeof organizationJoinRequests.$inferInsert),
							id: destinationId,
							organizationId: destinationOrganizationId,
							userId: targetUser(String(row.userId)) as string,
							invitationCodeId: targetEntity(
								"organization_invitation_code",
								typeof row.invitationCodeId === "string"
									? row.invitationCodeId
									: null,
								true,
							),
							reviewedBy: targetUser(
								typeof row.reviewedBy === "string" ? row.reviewedBy : null,
							),
						});
						if (ownedBefore.has(`${record.entityType}:${record.sourceId}`)) {
							await insertion.onConflictDoUpdate({
								target: organizationJoinRequests.id,
								set: {
									...(row as Partial<
										typeof organizationJoinRequests.$inferInsert
									>),
									organizationId: destinationOrganizationId,
									userId: targetUser(String(row.userId)) as string,
									invitationCodeId: targetEntity(
										"organization_invitation_code",
										typeof row.invitationCodeId === "string"
											? row.invitationCodeId
											: null,
										true,
									),
									reviewedBy: targetUser(
										typeof row.reviewedBy === "string" ? row.reviewedBy : null,
									),
								},
							});
						} else await insertion;
						break;
					}
					case "organization_activity": {
						destinationId = targetEntity(
							record.entityType,
							record.sourceId,
						) as string;
						await tx
							.insert(organizationActivityLogs)
							.values({
								...(row as typeof organizationActivityLogs.$inferInsert),
								id: destinationId,
								organizationId: destinationOrganizationId,
								actorUserId: targetUser(
									typeof row.actorUserId === "string" ? row.actorUserId : null,
								),
							})
							.onConflictDoUpdate({
								target: organizationActivityLogs.id,
								set: {
									...(row as Partial<
										typeof organizationActivityLogs.$inferInsert
									>),
									organizationId: destinationOrganizationId,
									actorUserId: targetUser(
										typeof row.actorUserId === "string"
											? row.actorUserId
											: null,
									),
								},
							});
						break;
					}
					case "automation_api_token": {
						destinationId = targetEntity(
							record.entityType,
							record.sourceId,
							true,
						) as string;
						const tokenSecret = await cryptography.decrypt(
							dataKey,
							String(row.tokenSecret),
						);
						const insertion = tx.insert(automationApiTokens).values({
							...(row as typeof automationApiTokens.$inferInsert),
							id: destinationId,
							orgId: destinationOrganizationId,
							userId: targetUser(String(row.userId)) as string,
							tokenSecret,
						});
						if (ownedBefore.has(`${record.entityType}:${record.sourceId}`)) {
							await insertion.onConflictDoUpdate({
								target: automationApiTokens.id,
								set: {
									...(row as Partial<typeof automationApiTokens.$inferInsert>),
									orgId: destinationOrganizationId,
									userId: targetUser(String(row.userId)) as string,
									tokenSecret,
								},
							});
						} else await insertion;
						break;
					}
					case "ai_access_token": {
						destinationId = targetEntity(
							record.entityType,
							record.sourceId,
							true,
						) as string;
						const tokenSecret =
							typeof row.tokenSecret === "string"
								? await cryptography.decrypt(dataKey, row.tokenSecret)
								: null;
						const insertion = tx.insert(aiAccessTokens).values({
							...(row as typeof aiAccessTokens.$inferInsert),
							id: destinationId,
							userId: targetUser(String(row.userId)) as string,
							tokenSecret,
						});
						if (ownedBefore.has(`${record.entityType}:${record.sourceId}`)) {
							await insertion.onConflictDoUpdate({
								target: aiAccessTokens.id,
								set: {
									...(row as Partial<typeof aiAccessTokens.$inferInsert>),
									userId: targetUser(String(row.userId)) as string,
									tokenSecret,
								},
							});
						} else await insertion;
						break;
					}
					case "ai_access_token_usage": {
						destinationId = targetEntity(
							record.entityType,
							record.sourceId,
						) as string;
						await tx
							.insert(aiAccessTokenUsageLogs)
							.values({
								...(row as typeof aiAccessTokenUsageLogs.$inferInsert),
								id: destinationId,
								tokenId: targetEntity(
									"ai_access_token",
									String(row.tokenId),
									true,
								) as string,
								userId: targetUser(String(row.userId)) as string,
								evidenceId: targetEntity(
									"evidence",
									typeof row.evidenceId === "string" ? row.evidenceId : null,
								),
							})
							.onConflictDoUpdate({
								target: aiAccessTokenUsageLogs.id,
								set: {
									...(row as Partial<
										typeof aiAccessTokenUsageLogs.$inferInsert
									>),
									tokenId: targetEntity(
										"ai_access_token",
										String(row.tokenId),
										true,
									) as string,
									userId: targetUser(String(row.userId)) as string,
									evidenceId: targetEntity(
										"evidence",
										typeof row.evidenceId === "string" ? row.evidenceId : null,
									),
								},
							});
						break;
					}
					default:
						throw new MigrationWorkerError(
							"MIGRATION_ENTITY_UNSUPPORTED",
							`Unsupported migration entity type: ${record.entityType}`,
						);
				}
				await tx
					.insert(migrationEntityMappings)
					.values({
						linkId: link.id,
						entityType: record.entityType,
						sourceEntityId: record.sourceId,
						destinationEntityId: destinationId,
						lastImportedHash: record.contentHash,
						lastSeenRunId: run.id,
					})
					.onConflictDoUpdate({
						target: [
							migrationEntityMappings.linkId,
							migrationEntityMappings.entityType,
							migrationEntityMappings.sourceEntityId,
						],
						set: {
							lastImportedHash: record.contentHash,
							lastSeenRunId: run.id,
							updatedAt: now(),
						},
					});
				await tx
					.update(organizationMigrationItems)
					.set({ status: "published", updatedAt: now() })
					.where(eq(organizationMigrationItems.id, item.id));
			}
			const staleMappings = await tx
				.select()
				.from(migrationEntityMappings)
				.where(
					and(
						eq(migrationEntityMappings.linkId, link.id),
						ne(migrationEntityMappings.lastSeenRunId, run.id),
					),
				);
			const deletePriority = [
				"ai_access_token_usage",
				"ai_access_token",
				"automation_api_token",
				"organization_activity",
				"organization_join_request",
				"organization_invitation",
				"share_link",
				"desktop_recording_session",
				"evidence_tag_assignment",
				"evidence_comment",
				"evidence_artifact",
				"evidence",
				"organization_member",
				"organization_invitation_code",
				"evidence_tag",
				"organization_role",
			];
			for (const mapping of staleMappings.sort(
				(left, right) =>
					deletePriority.indexOf(left.entityType) -
					deletePriority.indexOf(right.entityType),
			)) {
				switch (mapping.entityType) {
					case "ai_access_token_usage":
						await tx
							.delete(aiAccessTokenUsageLogs)
							.where(
								eq(aiAccessTokenUsageLogs.id, mapping.destinationEntityId),
							);
						break;
					case "ai_access_token":
						await tx
							.delete(aiAccessTokens)
							.where(eq(aiAccessTokens.id, mapping.destinationEntityId));
						break;
					case "automation_api_token":
						await tx
							.delete(automationApiTokens)
							.where(eq(automationApiTokens.id, mapping.destinationEntityId));
						break;
					case "organization_activity":
						await tx
							.delete(organizationActivityLogs)
							.where(
								eq(organizationActivityLogs.id, mapping.destinationEntityId),
							);
						break;
					case "organization_join_request":
						await tx
							.delete(organizationJoinRequests)
							.where(
								eq(organizationJoinRequests.id, mapping.destinationEntityId),
							);
						break;
					case "organization_invitation":
						await tx
							.delete(organizationInvitations)
							.where(
								eq(organizationInvitations.id, mapping.destinationEntityId),
							);
						break;
					case "share_link":
						await tx
							.delete(shareLinks)
							.where(eq(shareLinks.id, mapping.destinationEntityId));
						break;
					case "desktop_recording_session":
						await tx
							.delete(desktopRecordingSessions)
							.where(
								eq(desktopRecordingSessions.id, mapping.destinationEntityId),
							);
						break;
					case "evidence_tag_assignment": {
						const [evidenceId, tagId] = mapping.destinationEntityId.split(":");
						if (evidenceId && tagId) {
							await tx
								.delete(evidenceTagAssignments)
								.where(
									and(
										eq(evidenceTagAssignments.evidenceId, evidenceId),
										eq(evidenceTagAssignments.tagId, tagId),
									),
								);
						}
						break;
					}
					case "evidence_comment":
						await tx
							.delete(evidenceComments)
							.where(eq(evidenceComments.id, mapping.destinationEntityId));
						break;
					case "evidence_artifact":
						await tx
							.delete(evidenceArtifacts)
							.where(eq(evidenceArtifacts.id, mapping.destinationEntityId));
						break;
					case "evidence":
						await tx
							.delete(evidences)
							.where(eq(evidences.id, mapping.destinationEntityId));
						break;
					case "organization_member":
						await tx
							.delete(organizationMembers)
							.where(eq(organizationMembers.id, mapping.destinationEntityId));
						break;
					case "organization_invitation_code":
						await tx
							.delete(organizationInvitationCodes)
							.where(
								eq(organizationInvitationCodes.id, mapping.destinationEntityId),
							);
						break;
					case "evidence_tag":
						await tx
							.delete(organizationEvidenceTags)
							.where(
								eq(organizationEvidenceTags.id, mapping.destinationEntityId),
							);
						break;
					case "organization_role":
						break;
				}
				if (mapping.entityType !== "organization") {
					await tx
						.delete(migrationEntityMappings)
						.where(
							and(
								eq(migrationEntityMappings.linkId, mapping.linkId),
								eq(migrationEntityMappings.entityType, mapping.entityType),
								eq(
									migrationEntityMappings.sourceEntityId,
									mapping.sourceEntityId,
								),
							),
						);
				}
			}
			const receipt =
				run.kind === "final"
					? JSON.stringify({
							linkId: link.id,
							runId: run.id,
							manifestHash: run.manifestHash,
							verifiedAt: now(),
							signature: await cryptography.hmac(
								input.runtime.secret as string,
								`${link.id}:${run.id}:${run.manifestHash}`,
							),
						})
					: null;
			await tx
				.update(organizationMigrationStates)
				.set({
					accessState:
						run.kind === "final" ? "ready_to_activate" : "synced_read_only",
					verificationReceipt: receipt,
					updatedAt: now(),
				})
				.where(
					eq(
						organizationMigrationStates.organizationId,
						destinationOrganizationId,
					),
				);
			await tx
				.update(organizationMigrationLinks)
				.set({
					state: run.kind === "final" ? "finalizing" : "synced",
					lastSuccessfulManifestHash: run.manifestHash,
					...(run.kind === "final"
						? { finalManifestHash: run.manifestHash }
						: {}),
					verificationReceipt: receipt,
					lastSuccessfulAt: now(),
					updatedAt: now(),
				})
				.where(eq(organizationMigrationLinks.id, link.id));
			if (run.kind === "final") {
				await tx
					.update(organizationMigrationRuns)
					.set({ errorMessage: receipt })
					.where(eq(organizationMigrationRuns.id, run.id));
			}
		});

		await recordMigrationActivity({
			organizationId: destinationOrganizationId,
			action:
				run.kind === "final"
					? "migration.final-verification-succeeded"
					: "migration.sync-succeeded",
			message:
				run.kind === "final"
					? "Final migration verification succeeded"
					: `${run.kind} migration import succeeded`,
			entityId: run.id,
		});
		return "succeeded";
	};

	const processRun: MigrationRunHandler = async (run, controls) => {
		if (!run.organizationId) {
			throw new MigrationWorkerError(
				"MIGRATION_RUN_ORGANIZATION_MISSING",
				"Migration run has no local organization",
			);
		}
		const link = await input.db.query.organizationMigrationLinks.findFirst({
			where: eq(organizationMigrationLinks.id, run.linkId),
		});
		if (!link)
			throw new MigrationWorkerError(
				"MIGRATION_LINK_MISSING",
				"Migration link is missing",
			);
		if (link.direction === "inbound") {
			return processInboundPublication(run, link, controls);
		}
		if (
			!input.runtime.secret ||
			!link.encryptedSessionToken ||
			!link.encryptedDataKey
		) {
			throw new MigrationWorkerError(
				"MIGRATION_CREDENTIALS_MISSING",
				"Migration link credentials are unavailable",
			);
		}
		if (
			run.kind === "final" &&
			link.state === "completed" &&
			link.verificationReceipt
		) {
			const receipt = link.verificationReceipt;
			const sessionToken = await cryptography.decrypt(
				input.runtime.secret,
				link.encryptedSessionToken,
			);
			await migrationPeerRequest(async () =>
				input.peerClient.finalizeAck(
					{
						linkId: link.id,
						apiOrigin: link.remoteApiOrigin,
						sessionToken,
					},
					receipt,
				),
			);
			await input.db
				.update(organizationMigrationLinks)
				.set({
					encryptedSessionToken: null,
					encryptedDataKey: null,
					credentialsWipedAt: now(),
					updatedAt: now(),
				})
				.where(eq(organizationMigrationLinks.id, link.id));
			return "succeeded";
		}
		if (run.kind === "final") {
			const sourceArtifacts = await input.db
				.select({ status: evidenceArtifacts.uploadStatus })
				.from(evidenceArtifacts)
				.innerJoin(evidences, eq(evidences.id, evidenceArtifacts.evidenceId))
				.where(eq(evidences.orgId, run.organizationId));
			if (sourceArtifacts.some((artifact) => artifact.status !== "uploaded")) {
				throw new MigrationWorkerError(
					"SOURCE_ARTIFACT_INCOMPLETE",
					"Finalization requires every source artifact upload to be successful",
				);
			}
		}
		await controls.checkpoint("manifest");
		let snapshot: SourceSnapshot | null = null;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const first = await scanSourceOrganization(run.organizationId);
			const second = await scanSourceOrganization(run.organizationId);
			if (first.manifestHash === second.manifestHash) {
				snapshot = second;
				break;
			}
		}
		if (!snapshot) {
			throw new MigrationWorkerError(
				"SOURCE_BUSY",
				"Source metadata did not stabilize after three scans",
				true,
			);
		}
		await input.db
			.update(organizationMigrationRuns)
			.set({
				manifestHash: snapshot.manifestHash,
				identityTotal: snapshot.records.filter(
					(record) => record.entityType === "identity",
				).length,
				recordTotal: snapshot.records.length,
				artifactTotal: snapshot.artifacts.length,
				bytesTotal: snapshot.artifacts.reduce(
					(sum, artifact) => sum + artifact.size,
					0,
				),
				updatedAt: now(),
			})
			.where(eq(organizationMigrationRuns.id, run.id));
		const sessionToken = await cryptography.decrypt(
			input.runtime.secret,
			link.encryptedSessionToken,
		);
		const dataKey = await cryptography.decrypt(
			input.runtime.secret,
			link.encryptedDataKey,
		);
		const peerLink = {
			linkId: link.id,
			apiOrigin: link.remoteApiOrigin,
			sessionToken,
		};
		const opened = await migrationPeerRequest(() =>
			input.peerClient.openRun(peerLink, {
				sourceRunId: run.sourceRunId,
				kind: run.kind,
				manifestHash: snapshot.manifestHash,
				override: run.override,
			}),
		);
		const verified = new Set(opened.verifiedHashes);
		for (
			let offset = 0, page = 0;
			offset < snapshot.manifest.length;
			offset += 100, page += 1
		) {
			const entries = snapshot.manifest.slice(offset, offset + 100);
			await migrationPeerRequest(async () =>
				input.peerClient.putManifestPage(peerLink, opened.runId, page, {
					contentHash: await canonicalHash(entries),
					entries,
					isLast: offset + 100 >= snapshot.manifest.length,
				}),
			);
			await controls.checkpoint("manifest");
		}
		await controls.checkpoint("identities");
		const transferableRecords = snapshot.records.filter(
			(record) => !verified.has(record.contentHash),
		);
		for (
			let offset = 0, page = 0;
			offset < transferableRecords.length;
			offset += 100, page += 1
		) {
			const plainRecords = transferableRecords.slice(offset, offset + 100);
			const records = await Promise.all(
				plainRecords.map(async (record) => {
					if (
						(record.entityType === "automation_api_token" ||
							record.entityType === "ai_access_token") &&
						typeof record.payload.tokenSecret === "string"
					) {
						return {
							...record,
							payload: {
								...record.payload,
								tokenSecret: await cryptography.encrypt(
									dataKey,
									record.payload.tokenSecret,
								),
							},
						};
					}
					return record;
				}),
			);
			await migrationPeerRequest(async () =>
				input.peerClient.putRecordPage(peerLink, opened.runId, page, {
					contentHash: await canonicalHash(
						records.map((record) => ({
							entityType: record.entityType,
							sourceId: record.sourceId,
							contentHash: record.contentHash,
						})),
					),
					records,
				}),
			);
			await input.db
				.update(organizationMigrationRuns)
				.set({
					recordCompleted: offset + plainRecords.length,
					updatedAt: now(),
				})
				.where(eq(organizationMigrationRuns.id, run.id));
			await controls.checkpoint("records");
		}
		for (let index = 0; index < snapshot.artifacts.length; index += 1) {
			const artifact = snapshot.artifacts[index];
			if (!artifact) continue;
			if (!verified.has(artifact.contentHash)) {
				const body = await input.artifactStorage.getObject({
					key: artifact.storageKey,
				});
				const actualHash = await cryptography.sha256(body);
				if (actualHash !== artifact.contentHash) {
					throw new MigrationWorkerError(
						"SOURCE_CHECKSUM_MISMATCH",
						`Source artifact ${artifact.id} does not match its stored checksum`,
					);
				}
				await migrationPeerRequest(() =>
					input.peerClient.putArtifact(peerLink, opened.runId, artifact.id, {
						body,
						contentHash: artifact.contentHash,
						contentType: artifact.contentType,
						size: artifact.size,
					}),
				);
			}
			await input.db
				.update(organizationMigrationRuns)
				.set({
					artifactCompleted: index + 1,
					bytesTransferred: snapshot.artifacts
						.slice(0, index + 1)
						.reduce((sum, item) => sum + item.size, 0),
					updatedAt: now(),
				})
				.where(eq(organizationMigrationRuns.id, run.id));
			await controls.checkpoint("artifacts");
		}
		await controls.checkpoint("verify");
		const commit = await migrationPeerRequest(() =>
			input.peerClient.commit(peerLink, opened.runId, {
				manifestHash: snapshot.manifestHash,
				recordCount: snapshot.records.length,
				artifactCount: snapshot.artifacts.length,
				totalBytes: snapshot.artifacts.reduce(
					(sum, artifact) => sum + artifact.size,
					0,
				),
			}),
		);
		if (commit.status === "failed") {
			throw new MigrationWorkerError(
				commit.errorCode ?? "MIGRATION_IMPORT_FAILED",
				commit.errorMessage ?? "Destination import failed",
			);
		}
		if (commit.status !== "succeeded") return "waiting_peer";
		const receipt = typeof commit.receipt === "string" ? commit.receipt : null;
		await controls.checkpoint(run.kind === "final" ? "finalize" : "publish");
		await input.db.transaction(async (tx) => {
			await tx
				.update(organizationMigrationLinks)
				.set({
					state: run.kind === "final" ? "completed" : "synced",
					lastSuccessfulManifestHash: snapshot.manifestHash,
					...(run.kind === "final"
						? { finalManifestHash: snapshot.manifestHash }
						: {}),
					verificationReceipt: receipt,
					lastSuccessfulAt: now(),
					updatedAt: now(),
				})
				.where(eq(organizationMigrationLinks.id, link.id));
			await tx
				.update(organizationMigrationStates)
				.set({
					accessState:
						run.kind === "final" ? "completed_source_read_only" : "writable",
					verificationReceipt: receipt,
					updatedAt: now(),
				})
				.where(
					eq(
						organizationMigrationStates.organizationId,
						run.organizationId as string,
					),
				);
		});
		if (run.kind === "final" && receipt) {
			await migrationPeerRequest(() =>
				input.peerClient.finalizeAck(peerLink, receipt),
			);
			await input.db
				.update(organizationMigrationLinks)
				.set({
					encryptedSessionToken: null,
					encryptedDataKey: null,
					credentialsWipedAt: now(),
					updatedAt: now(),
				})
				.where(eq(organizationMigrationLinks.id, link.id));
		}
		await recordMigrationActivity({
			organizationId: run.organizationId,
			action:
				run.kind === "final"
					? "migration.finalization-completed"
					: "migration.sync-succeeded",
			message:
				run.kind === "final"
					? "Migration finalization completed; source is read-only"
					: `${run.kind} migration sync succeeded`,
			entityId: run.id,
		});
		return "succeeded";
	};

	const cleanupMaintenance = async (): Promise<{
		receiverCodes: number;
		payloads: number;
	}> => {
		const cutoff = now() - 24 * 60 * 60 * 1_000;
		const removedCodes = await input.db
			.delete(migrationReceiverCodes)
			.where(
				or(
					lt(migrationReceiverCodes.expiresAt, cutoff),
					and(
						isNotNull(migrationReceiverCodes.redeemedAt),
						lt(migrationReceiverCodes.redeemedAt, cutoff),
					),
					and(
						isNotNull(migrationReceiverCodes.revokedAt),
						lt(migrationReceiverCodes.revokedAt, cutoff),
					),
				),
			)
			.returning({ id: migrationReceiverCodes.id });
		const succeededRuns =
			await input.db.query.organizationMigrationRuns.findMany({
				where: eq(organizationMigrationRuns.status, "succeeded"),
				columns: { id: true },
			});
		if (succeededRuns.length === 0) {
			return { receiverCodes: removedCodes.length, payloads: 0 };
		}
		const cleaned = await input.db
			.update(organizationMigrationItems)
			.set({ stagedPayload: null, stagedObjectKey: null, updatedAt: now() })
			.where(
				and(
					inArray(
						organizationMigrationItems.runId,
						succeededRuns.map((run) => run.id),
					),
					or(
						isNotNull(organizationMigrationItems.stagedPayload),
						isNotNull(organizationMigrationItems.stagedObjectKey),
					),
				),
			)
			.returning({ id: organizationMigrationItems.id });
		return { receiverCodes: removedCodes.length, payloads: cleaned.length };
	};

	return {
		createReceiverCode,
		checkCompatibility,
		pairOutbound,
		startRun,
		pauseRun,
		resumeRun,
		retryRun,
		abortFinalization,
		breakFinalizedLink,
		getStatus,
		revokeReceiverCode,
		listInbound,
		acceptHandshake,
		getInstanceId,
		processRun,
		openInboundRun,
		putInboundManifestPage,
		putInboundRecordPage,
		putInboundArtifact,
		commitInboundRun,
		getInboundRun,
		finalizeInbound,
		markInboundDiverged,
		cleanupMaintenance,
	};
};
