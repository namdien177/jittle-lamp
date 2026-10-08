import { z } from "zod/v4";

// Organisation storage: usage statistics and bring-your-own S3-compatible buckets.
// `storageId: null` always means the JittleLamp default storage.

export const storageArtifactKindSchema = z.enum([
	"recording",
	"transcript",
	"screenshot",
	"network-log",
	"attachment",
]);
export type StorageArtifactKind = z.infer<typeof storageArtifactKindSchema>;

export const storageUsageGranularitySchema = z.enum(["day", "month"]);
export type StorageUsageGranularity = z.infer<
	typeof storageUsageGranularitySchema
>;

const usageSliceSchema = z.object({
	bytes: z.number().int().nonnegative(),
	artifactCount: z.number().int().nonnegative(),
});

export const storageUsageReportSchema = z.object({
	orgId: z.string(),
	generatedAt: z.number().int(),
	from: z.string(),
	to: z.string(),
	granularity: storageUsageGranularitySchema,
	totals: z.object({
		bytes: z.number().int().nonnegative(),
		artifactCount: z.number().int().nonnegative(),
		evidenceCount: z.number().int().nonnegative(),
		// Soft-deleted evidence still occupies storage until it is purged.
		binBytes: z.number().int().nonnegative(),
	}),
	byStorage: z.array(
		usageSliceSchema.extend({
			storageId: z.string().nullable(),
			name: z.string(),
			removed: z.boolean(),
		}),
	),
	byMember: z.array(
		usageSliceSchema.extend({
			userId: z.string().nullable(),
			name: z.string(),
			email: z.string().nullable(),
			evidenceCount: z.number().int().nonnegative(),
		}),
	),
	byKind: z.array(usageSliceSchema.extend({ kind: storageArtifactKindSchema })),
	// `addedBytes`: uploaded in the bucket period. `storedBytes`: stored at the end of the period
	// (daily snapshot, or cumulative uploads for periods before snapshots existed).
	timeline: z.array(
		z.object({
			bucket: z.string(),
			addedBytes: z.number().int().nonnegative(),
			addedArtifacts: z.number().int().nonnegative(),
			storedBytes: z.number().int().nonnegative(),
		}),
	),
});
export type StorageUsageReport = z.infer<typeof storageUsageReportSchema>;

export const organizationStorageSchema = z.object({
	id: z.string(),
	name: z.string(),
	endpoint: z.string().nullable(),
	region: z.string(),
	bucket: z.string(),
	keyPrefix: z.string().nullable(),
	forcePathStyle: z.boolean(),
	serverSideEncryption: z.boolean(),
	accessKeyLast4: z.string().nullable(),
	status: z.enum(["active", "deleted"]),
	lastVerifiedAt: z.number().int().nullable(),
	createdAt: z.number().int(),
	deletedAt: z.number().int().nullable(),
	usage: usageSliceSchema,
});
export type OrganizationStorage = z.infer<typeof organizationStorageSchema>;

export const storageTransferStatusSchema = z.enum([
	"queued",
	"running",
	"pause_requested",
	"paused",
	"completed",
	"failed",
	"cancelled",
]);
export type StorageTransferStatus = z.infer<typeof storageTransferStatusSchema>;

export const storageTransferSchema = z.object({
	id: z.string(),
	sourceStorageId: z.string().nullable(),
	targetStorageId: z.string(),
	status: storageTransferStatusSchema,
	artifactsTotal: z.number().int().nonnegative(),
	artifactsDone: z.number().int().nonnegative(),
	artifactsFailed: z.number().int().nonnegative(),
	bytesTotal: z.number().int().nonnegative(),
	bytesDone: z.number().int().nonnegative(),
	lastError: z.string().nullable(),
	createdAt: z.number().int(),
	startedAt: z.number().int().nullable(),
	completedAt: z.number().int().nullable(),
});
export type StorageTransfer = z.infer<typeof storageTransferSchema>;

export const storageSettingsSchema = z.object({
	defaultStorageId: z.string().nullable(),
	defaultStorageDisabled: z.boolean(),
});
export type StorageSettings = z.infer<typeof storageSettingsSchema>;

export const organizationStorageOverviewSchema = z.object({
	canManage: z.boolean(),
	// Whether this server can encrypt storage credentials (JL_SECRETS_MASTER_KEY).
	secretsAvailable: z.boolean(),
	settings: storageSettingsSchema,
	defaultStorageUsage: usageSliceSchema,
	storages: z.array(organizationStorageSchema),
	activeTransfer: storageTransferSchema.nullable(),
	recentTransfers: z.array(storageTransferSchema),
});
export type OrganizationStorageOverview = z.infer<
	typeof organizationStorageOverviewSchema
>;

export const storageImpactSchema = z.object({
	storageId: z.string(),
	artifactCount: z.number().int().nonnegative(),
	evidenceCount: z.number().int().nonnegative(),
	bytes: z.number().int().nonnegative(),
});
export type StorageImpact = z.infer<typeof storageImpactSchema>;

const bucketNamePattern = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const keyPrefixPattern = /^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/;

// Blank form fields mean "not set".
const blank = z
	.string()
	.trim()
	.length(0)
	.transform(() => null);
const endpointField = z.union([blank, z.string().trim().url()]).nullable();
const keyPrefixField = z
	.union([
		blank,
		z
			.string()
			.trim()
			.regex(keyPrefixPattern, "Letters, digits, - and _ separated by /"),
	])
	.nullable();

export const storageConnectionInputSchema = z.object({
	endpoint: endpointField.optional().transform((value) => value ?? null),
	region: z.string().trim().min(1).max(64),
	bucket: z
		.string()
		.trim()
		.regex(bucketNamePattern, "Use a valid S3 bucket name"),
	keyPrefix: keyPrefixField.optional().transform((value) => value ?? null),
	forcePathStyle: z.boolean().default(false),
	serverSideEncryption: z.boolean().default(true),
	accessKeyId: z.string().trim().min(1).max(256),
	secretAccessKey: z.string().min(1).max(512),
});
export type StorageConnectionInput = z.input<
	typeof storageConnectionInputSchema
>;

export const createOrganizationStorageInputSchema =
	storageConnectionInputSchema.extend({
		name: z.string().trim().min(1).max(80),
	});
export type CreateOrganizationStorageInput = z.input<
	typeof createOrganizationStorageInputSchema
>;

// Renaming and rotating credentials are always allowed; the bucket location can only change
// while the storage holds no artifacts.
export const updateOrganizationStorageInputSchema = z.object({
	name: z.string().trim().min(1).max(80).optional(),
	// null (or blank) clears the endpoint (AWS S3); omitted keeps it.
	endpoint: endpointField.optional(),
	region: z.string().trim().min(1).max(64).optional(),
	bucket: z
		.string()
		.trim()
		.regex(bucketNamePattern, "Use a valid S3 bucket name")
		.optional(),
	keyPrefix: keyPrefixField.optional(),
	forcePathStyle: z.boolean().optional(),
	serverSideEncryption: z.boolean().optional(),
	accessKeyId: z.string().trim().min(1).max(256).optional(),
	secretAccessKey: z.string().min(1).max(512).optional(),
});
export type UpdateOrganizationStorageInput = z.input<
	typeof updateOrganizationStorageInputSchema
>;

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024)
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
