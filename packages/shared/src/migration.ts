import { z } from "zod/v4";

export const MIGRATION_PROTOCOL_VERSION = "1.0" as const;

export const migrationRunStatusSchema = z.enum([
	"queued",
	"running",
	"waiting_peer",
	"pause_requested",
	"paused",
	"failed",
	"succeeded",
	"cancelled",
]);
export type MigrationRunStatus = z.infer<typeof migrationRunStatusSchema>;

export const migrationStageSchema = z.enum([
	"preflight",
	"manifest",
	"identities",
	"records",
	"artifacts",
	"verify",
	"publish",
	"finalize",
]);
export type MigrationStage = z.infer<typeof migrationStageSchema>;

export const migrationAccessStateSchema = z.enum([
	"importing",
	"synced_read_only",
	"finalizing_read_only",
	"completed_source_read_only",
	"ready_to_activate",
	"writable",
	"diverged",
]);
export type MigrationAccessState = z.infer<typeof migrationAccessStateSchema>;

const progressCounterSchema = z.object({
	completed: z.number().int().nonnegative(),
	total: z.number().int().nonnegative(),
});

export const migrationProgressSchema = z.object({
	identities: progressCounterSchema,
	records: progressCounterSchema,
	artifacts: progressCounterSchema,
	bytes: z.object({
		transferred: z.number().int().nonnegative(),
		total: z.number().int().nonnegative(),
	}),
	warnings: z.array(z.string()),
});
export type MigrationProgress = z.infer<typeof migrationProgressSchema>;

export const emptyMigrationProgress = (): MigrationProgress => ({
	identities: { completed: 0, total: 0 },
	records: { completed: 0, total: 0 },
	artifacts: { completed: 0, total: 0 },
	bytes: { transferred: 0, total: 0 },
	warnings: [],
});

export const migrationRunSchema = z.object({
	id: z.string().uuid(),
	linkId: z.string().uuid(),
	organizationId: z.string().uuid(),
	kind: z.enum(["full", "delta", "final"]),
	status: migrationRunStatusSchema,
	stage: migrationStageSchema,
	override: z.boolean(),
	progress: migrationProgressSchema,
	errorCode: z.string().nullable(),
	errorMessage: z.string().nullable(),
	attempts: z.number().int().nonnegative(),
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
	completedAt: z.number().int().nullable(),
});
export type MigrationRun = z.infer<typeof migrationRunSchema>;

export const migrationLinkSchema = z.object({
	id: z.string().uuid(),
	direction: z.enum(["inbound", "outbound"]),
	localOrganizationId: z.string().uuid().nullable(),
	remoteOrganizationId: z.string().uuid().nullable(),
	remoteInstanceId: z.string().uuid(),
	remoteApiOrigin: z.string().url(),
	remoteWebOrigin: z.string().url(),
	protocolVersion: z.string(),
	state: z.enum([
		"paired",
		"syncing",
		"synced",
		"finalizing",
		"completed",
		"diverged",
		"broken",
	]),
	lastSuccessfulAt: z.number().int().nullable(),
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
});
export type MigrationLink = z.infer<typeof migrationLinkSchema>;

export const receiverCodeSchema = z.object({
	id: z.string().uuid(),
	passphrase: z.string().startsWith("jl_mig_"),
	apiOrigin: z.string().url(),
	expiresAt: z.number().int(),
	createdAt: z.number().int(),
});
export type ReceiverCode = z.infer<typeof receiverCodeSchema>;

export const pairOutboundInputSchema = z.object({
	actorUserId: z.string().uuid(),
	organizationId: z.string().uuid(),
	targetApiOrigin: z.string().url(),
	passphrase: z.string().startsWith("jl_mig_").min(50),
});
export type PairOutboundInput = z.infer<typeof pairOutboundInputSchema>;

export const migrationStatusSchema = z.object({
	link: migrationLinkSchema.nullable(),
	run: migrationRunSchema.nullable(),
	accessState: migrationAccessStateSchema.nullable(),
	destinationWebOrigin: z.string().url().nullable(),
	verificationReceipt: z.string().nullable(),
});
export type MigrationStatus = z.infer<typeof migrationStatusSchema>;

export const migrationDiscoverySchema = z.object({
	product: z.literal("jittle-lamp"),
	instanceId: z.string().uuid(),
	applicationVersion: z.string().min(1),
	protocolVersion: z.string().regex(/^\d+\.\d+$/),
	features: z.array(z.string()),
	apiOrigin: z.string().url(),
	webOrigin: z.string().url(),
	limits: z.object({
		maxRecordsPerPage: z.number().int().min(1).max(100),
		maxArtifactBytes: z.number().int().positive(),
	}),
});
export type MigrationDiscovery = z.infer<typeof migrationDiscoverySchema>;

export const migrationCompatibilitySchema = z.object({
	targetApiOrigin: z.string().url(),
	targetWebOrigin: z.string().url(),
	instanceId: z.string().uuid(),
	applicationVersion: z.string().min(1),
	protocolVersion: z.string(),
	compatible: z.literal(true),
	features: z.array(z.string()),
	limits: migrationDiscoverySchema.shape.limits,
});
export type MigrationCompatibility = z.infer<
	typeof migrationCompatibilitySchema
>;

export const migrationHandshakeRequestSchema = z.object({
	passphrase: z.string().startsWith("jl_mig_"),
	sourceInstanceId: z.string().uuid(),
	sourceOrganizationId: z.string().uuid(),
	sourceOrganizationName: z.string().trim().min(1),
	sourceApiOrigin: z.string().url(),
	sourceWebOrigin: z.string().url(),
	protocolVersion: z.string(),
	operatorProof: z.string().min(32),
	operatorEmailHints: z.array(z.string().min(8)),
	encryptedLinkKey: z.string().min(1),
});
export type MigrationHandshakeRequest = z.infer<
	typeof migrationHandshakeRequestSchema
>;

export const migrationHandshakeResponseSchema = z.object({
	linkId: z.string().uuid(),
	destinationInstanceId: z.string().uuid(),
	destinationOrganizationId: z.string().uuid(),
	destinationWebOrigin: z.string().url(),
	protocolVersion: z.string(),
	sessionToken: z.string().min(32),
});

export const migrationManifestEntrySchema = z.object({
	kind: z.enum(["record", "artifact"]),
	entityType: z.string().min(1),
	sourceId: z.string().min(1),
	contentHash: z.string().regex(/^[a-f0-9]{64}$/),
	byteSize: z.number().int().nonnegative().optional(),
});
export type MigrationManifestEntry = z.infer<
	typeof migrationManifestEntrySchema
>;

export const migrationManifestPageSchema = z.object({
	page: z.number().int().nonnegative(),
	contentHash: z.string().regex(/^[a-f0-9]{64}$/),
	entries: z.array(migrationManifestEntrySchema).max(100),
	isLast: z.boolean(),
});

export const migrationRecordSchema = z.object({
	entityType: z.string().min(1),
	sourceId: z.string().min(1),
	contentHash: z.string().regex(/^[a-f0-9]{64}$/),
	payload: z.record(z.string(), z.unknown()),
});
export type MigrationRecord = z.infer<typeof migrationRecordSchema>;

export const migrationRecordPageSchema = z.object({
	page: z.number().int().nonnegative(),
	contentHash: z.string().regex(/^[a-f0-9]{64}$/),
	records: z.array(migrationRecordSchema).max(100),
});

export const openMigrationRunSchema = z.object({
	sourceRunId: z.string().uuid(),
	kind: z.enum(["full", "delta", "final"]),
	manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
	override: z.boolean().default(false),
});

export const migrationCommitSchema = z.object({
	manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
	recordCount: z.number().int().nonnegative(),
	artifactCount: z.number().int().nonnegative(),
	totalBytes: z.number().int().nonnegative(),
});

export const migrationVerificationReceiptSchema = z.object({
	linkId: z.string().uuid(),
	runId: z.string().uuid(),
	manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
	verifiedAt: z.number().int(),
	signature: z.string().min(32),
});
export type MigrationVerificationReceipt = z.infer<
	typeof migrationVerificationReceiptSchema
>;

const canonicalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalize(child)]),
		);
	}
	return value;
};

export const canonicalJson = (value: unknown): string =>
	JSON.stringify(canonicalize(value));

export const sha256Hex = async (value: string | Uint8Array): Promise<string> => {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	const digest = await crypto.subtle.digest(
		"SHA-256",
		Uint8Array.from(bytes).buffer,
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
};

export const canonicalHash = (value: unknown): Promise<string> =>
	sha256Hex(canonicalJson(value));

export const orderedManifestHash = (
	entries: readonly MigrationManifestEntry[],
): Promise<string> =>
	canonicalHash(
		[...entries]
			.sort((left, right) =>
				`${left.kind}:${left.entityType}:${left.sourceId}`.localeCompare(
					`${right.kind}:${right.entityType}:${right.sourceId}`,
				),
			)
			.map(({ kind, entityType, sourceId, contentHash, byteSize }) => ({
				kind,
				entityType,
				sourceId,
				contentHash,
				...(byteSize === undefined ? {} : { byteSize }),
			})),
	);
