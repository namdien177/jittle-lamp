import type {
	OrganizationStorage,
	OrganizationStorageOverview,
	StorageArtifactKind,
	StorageImpact,
	StorageSettings,
	StorageTransfer,
	StorageUsageGranularity,
	StorageUsageReport,
} from "@jittle-lamp/shared";
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	lt,
	lte,
	ne,
	type SQL,
	sql,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { RuntimeConfig } from "../config/runtime";
import {
	DEFAULT_STORAGE_KEY,
	evidenceArtifacts,
	evidences,
	organizationStorageDailyUsage,
	organizationStorageSettings,
	organizationStorages,
	organizationStorageTransfers,
	users,
} from "../db/schema";
import { createUuidV7 } from "../db/uuid";
import { HttpError } from "../http/test-http";
import {
	fallbackClerkUserProfile,
	formatClerkDisplayName,
	resolveClerkUserProfile,
} from "./clerk-user-profile";
import { withBusyRetry } from "./db-busy";
import { recordOrganizationActivity } from "./organization-activity";
import {
	assertOutboundUrl,
	OutboundBlockedError,
	type OutboundPolicy,
} from "./outbound-http";
import {
	type StorageCredentials,
	type StorageRegistry,
	type StorageRow,
	storageConfigFromRow,
	verifyStorageRoundTrip,
} from "./storage-registry";
import {
	SecretsUnavailableError,
	STORAGE_CREDENTIAL_KIND,
	type TestSecrets,
} from "./test-config";
import type { BackendDb } from "./user-provisioning";

export class OrganizationStorageError extends HttpError {
	constructor(code: string, message: string, status: number) {
		super(status, code, message);
		this.name = "OrganizationStorageError";
	}
}

export const ACTIVE_TRANSFER_STATUSES = [
	"queued",
	"running",
	"pause_requested",
	"paused",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAY_BUCKETS = 366;
const MAX_MONTH_BUCKETS = 60;
const MAX_MEMBER_ROWS = 100;

// `column IS ?`: for storage ids, null means the JittleLamp default storage.
export const nullableEquals = (
	column: SQLiteColumn,
	storageId: string | null,
): SQL => (storageId === null ? isNull(column) : eq(column, storageId));

const utcDay = (millis: number) => new Date(millis).toISOString().slice(0, 10);
const utcMonth = (millis: number) => new Date(millis).toISOString().slice(0, 7);
const parseDay = (value: string): number | null => {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const parsed = Date.parse(`${value}T00:00:00.000Z`);
	return Number.isNaN(parsed) ? null : parsed;
};

const toNumber = (value: unknown): number => {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
};

const publicTransfer = (
	row: typeof organizationStorageTransfers.$inferSelect,
): StorageTransfer => ({
	id: row.id,
	sourceStorageId: row.sourceStorageId,
	targetStorageId: row.targetStorageId,
	status: row.status,
	artifactsTotal: row.artifactsTotal,
	artifactsDone: row.artifactsDone,
	artifactsFailed: row.artifactsFailed,
	bytesTotal: row.bytesTotal,
	bytesDone: row.bytesDone,
	lastError: row.lastError,
	createdAt: row.createdAt,
	startedAt: row.startedAt,
	completedAt: row.completedAt,
});

export type StorageConnectionFields = {
	endpoint: string | null;
	region: string;
	bucket: string;
	keyPrefix: string | null;
	forcePathStyle: boolean;
	serverSideEncryption: boolean;
};

export const createOrganizationStorageService = (input: {
	db: BackendDb;
	runtime: Pick<RuntimeConfig, "nodeEnv" | "clerkSecretKey">;
	registry: StorageRegistry;
	secrets: TestSecrets;
	outbound: OutboundPolicy;
	now?: () => number;
}) => {
	const { db, registry, secrets } = input;
	const now = input.now ?? Date.now;

	const uploadedInOrg = (orgId: string) =>
		and(
			eq(evidences.orgId, orgId),
			eq(evidenceArtifacts.uploadStatus, "uploaded"),
		);

	const usageByStorage = async (
		orgId: string,
	): Promise<Map<string | null, { bytes: number; artifactCount: number }>> => {
		const rows = await db
			.select({
				storageId: evidenceArtifacts.storageId,
				bytes: sql<number>`coalesce(sum(${evidenceArtifacts.bytes}), 0)`,
				artifactCount: sql<number>`count(${evidenceArtifacts.id})`,
			})
			.from(evidenceArtifacts)
			.innerJoin(evidences, eq(evidences.id, evidenceArtifacts.evidenceId))
			.where(uploadedInOrg(orgId))
			.groupBy(evidenceArtifacts.storageId);
		return new Map(
			rows.map((row) => [
				row.storageId,
				{
					bytes: toNumber(row.bytes),
					artifactCount: toNumber(row.artifactCount),
				},
			]),
		);
	};

	const getSettings = async (orgId: string): Promise<StorageSettings> => {
		const row = await db.query.organizationStorageSettings.findFirst({
			where: eq(organizationStorageSettings.orgId, orgId),
		});
		return {
			defaultStorageId: row?.defaultStorageId ?? null,
			defaultStorageDisabled: row?.defaultStorageDisabled ?? false,
		};
	};

	const getStorageRow = async (
		orgId: string,
		storageId: string,
	): Promise<StorageRow> => {
		const row = await db.query.organizationStorages.findFirst({
			where: and(
				eq(organizationStorages.id, storageId),
				eq(organizationStorages.orgId, orgId),
			),
		});
		if (!row) {
			throw new OrganizationStorageError(
				"STORAGE_NOT_FOUND",
				"Storage not found",
				404,
			);
		}
		return row;
	};

	const getActiveStorageRow = async (orgId: string, storageId: string) => {
		const row = await getStorageRow(orgId, storageId);
		if (row.status !== "active") {
			throw new OrganizationStorageError(
				"STORAGE_REMOVED",
				"This storage was removed",
				409,
			);
		}
		return row;
	};

	const publicStorage = (
		row: StorageRow,
		usage: { bytes: number; artifactCount: number } | undefined,
	): OrganizationStorage => ({
		id: row.id,
		name: row.name,
		endpoint: row.endpoint,
		region: row.region,
		bucket: row.bucket,
		keyPrefix: row.keyPrefix,
		forcePathStyle: row.forcePathStyle,
		serverSideEncryption: row.serverSideEncryption,
		accessKeyLast4: row.accessKeyLast4,
		status: row.status,
		lastVerifiedAt: row.lastVerifiedAt,
		createdAt: row.createdAt,
		deletedAt: row.deletedAt,
		usage: usage ?? { bytes: 0, artifactCount: 0 },
	});

	const assertSecretsAvailable = () => {
		try {
			secrets.assertAvailable();
		} catch (error) {
			if (error instanceof SecretsUnavailableError) {
				throw new OrganizationStorageError(
					"SECRETS_UNAVAILABLE",
					"This server cannot store storage credentials (JL_SECRETS_MASTER_KEY is not set)",
					503,
				);
			}
			throw error;
		}
	};

	const secretsAvailable = () => {
		try {
			secrets.assertAvailable();
			return true;
		} catch {
			return false;
		}
	};

	// Endpoints are organisation-supplied addresses the API server connects to: same SSRF rules as
	// webhooks (services/outbound-http.ts), and https outside local development.
	const assertEndpointAllowed = async (endpoint: string | null) => {
		if (!endpoint) return;
		const local =
			input.runtime.nodeEnv === "local" ||
			input.runtime.nodeEnv === "development";
		let url: URL;
		try {
			url = await assertOutboundUrl(input.outbound, endpoint);
		} catch (error) {
			throw new OrganizationStorageError(
				"STORAGE_ENDPOINT_NOT_ALLOWED",
				error instanceof OutboundBlockedError
					? `Endpoint is not allowed: ${error.message}`
					: "Endpoint is not allowed",
				400,
			);
		}
		if (url.protocol !== "https:" && !local) {
			throw new OrganizationStorageError(
				"STORAGE_ENDPOINT_NOT_ALLOWED",
				"Endpoint must use https",
				400,
			);
		}
		if (url.pathname !== "/" && url.pathname !== "") {
			throw new OrganizationStorageError(
				"STORAGE_ENDPOINT_NOT_ALLOWED",
				"Endpoint must not contain a path; put the bucket name in Bucket",
				400,
			);
		}
	};

	const verifyConnection = async (
		fields: StorageConnectionFields,
		credentials: StorageCredentials,
	) => {
		await assertEndpointAllowed(fields.endpoint);
		const storage = registry.forConfig(
			storageConfigFromRow(fields, credentials),
		);
		try {
			await verifyStorageRoundTrip(storage);
		} catch (error) {
			throw new OrganizationStorageError(
				"STORAGE_CONNECTION_FAILED",
				`Could not write, read and delete a test object: ${
					error instanceof Error ? error.message : String(error)
				}`,
				422,
			);
		}
	};

	const storageArtifactCount = async (orgId: string, storageId: string) => {
		const [row] = await db
			.select({
				artifactCount: sql<number>`count(${evidenceArtifacts.id})`,
				evidenceCount: sql<number>`count(distinct ${evidences.id})`,
				bytes: sql<number>`coalesce(sum(case when ${evidenceArtifacts.uploadStatus} = 'uploaded' then ${evidenceArtifacts.bytes} else 0 end), 0)`,
			})
			.from(evidenceArtifacts)
			.innerJoin(evidences, eq(evidences.id, evidenceArtifacts.evidenceId))
			.where(
				and(
					eq(evidences.orgId, orgId),
					eq(evidenceArtifacts.storageId, storageId),
				),
			);
		return {
			artifactCount: toNumber(row?.artifactCount),
			evidenceCount: toNumber(row?.evidenceCount),
			bytes: toNumber(row?.bytes),
		};
	};

	const activeTransferFor = async (orgId: string) =>
		db.query.organizationStorageTransfers.findFirst({
			where: and(
				eq(organizationStorageTransfers.orgId, orgId),
				inArray(organizationStorageTransfers.status, [
					...ACTIVE_TRANSFER_STATUSES,
				]),
			),
			orderBy: desc(organizationStorageTransfers.createdAt),
		});

	return {
		getSettings,
		getActiveStorageRow,
		activeTransferFor,

		usageReport: async (args: {
			orgId: string;
			granularity: StorageUsageGranularity;
			from?: string | undefined;
			to?: string | undefined;
		}): Promise<StorageUsageReport> => {
			const generatedAt = now();
			const { granularity } = args;
			const toDay = args.to ? parseDay(args.to) : parseDay(utcDay(generatedAt));
			if (toDay === null) {
				throw new OrganizationStorageError(
					"INVALID_RANGE",
					"`to` must be YYYY-MM-DD",
					400,
				);
			}
			const defaultFrom =
				granularity === "day"
					? toDay - 29 * DAY_MS
					: Date.UTC(
							new Date(toDay).getUTCFullYear(),
							new Date(toDay).getUTCMonth() - 11,
							1,
						);
			const fromDay = args.from ? parseDay(args.from) : defaultFrom;
			if (fromDay === null || fromDay > toDay) {
				throw new OrganizationStorageError(
					"INVALID_RANGE",
					"`from` must be YYYY-MM-DD and not after `to`",
					400,
				);
			}

			const buckets: string[] = [];
			if (granularity === "day") {
				for (let day = fromDay; day <= toDay; day += DAY_MS) {
					buckets.push(utcDay(day));
					if (buckets.length > MAX_DAY_BUCKETS) break;
				}
			} else {
				const start = new Date(fromDay);
				for (
					let month = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1);
					month <= toDay;
					month = Date.UTC(
						new Date(month).getUTCFullYear(),
						new Date(month).getUTCMonth() + 1,
						1,
					)
				) {
					buckets.push(utcMonth(month));
					if (buckets.length > MAX_MONTH_BUCKETS) break;
				}
			}
			if (
				buckets.length >
				(granularity === "day" ? MAX_DAY_BUCKETS : MAX_MONTH_BUCKETS)
			) {
				throw new OrganizationStorageError(
					"INVALID_RANGE",
					granularity === "day"
						? "Use at most 366 days; switch to months for longer ranges"
						: "Use at most 60 months",
					400,
				);
			}
			const rangeStart =
				granularity === "day"
					? fromDay
					: Date.UTC(
							new Date(fromDay).getUTCFullYear(),
							new Date(fromDay).getUTCMonth(),
							1,
						);
			const rangeEnd = toDay + DAY_MS;

			const [totalsRow] = await db
				.select({
					bytes: sql<number>`coalesce(sum(${evidenceArtifacts.bytes}), 0)`,
					artifactCount: sql<number>`count(${evidenceArtifacts.id})`,
					evidenceCount: sql<number>`count(distinct case when ${evidences.deletedAt} is null then ${evidences.id} end)`,
					binBytes: sql<number>`coalesce(sum(case when ${evidences.deletedAt} is not null then ${evidenceArtifacts.bytes} else 0 end), 0)`,
				})
				.from(evidenceArtifacts)
				.innerJoin(evidences, eq(evidences.id, evidenceArtifacts.evidenceId))
				.where(uploadedInOrg(args.orgId));

			const storageUsage = await usageByStorage(args.orgId);
			const storageRows = await db.query.organizationStorages.findMany({
				where: eq(organizationStorages.orgId, args.orgId),
			});
			const storageById = new Map(storageRows.map((row) => [row.id, row]));
			const byStorage = [...storageUsage.entries()]
				.map(([storageId, usage]) => {
					const row = storageId ? storageById.get(storageId) : undefined;
					return {
						storageId,
						name: storageId
							? (row?.name ?? "Removed storage")
							: "JittleLamp storage",
						removed: storageId ? row?.status !== "active" : false,
						...usage,
					};
				})
				.sort((a, b) => b.bytes - a.bytes);

			const memberRows = await db
				.select({
					userId: evidences.createdBy,
					clerkUserId: users.clerkUserId,
					bytes: sql<number>`coalesce(sum(${evidenceArtifacts.bytes}), 0)`,
					artifactCount: sql<number>`count(${evidenceArtifacts.id})`,
					evidenceCount: sql<number>`count(distinct ${evidences.id})`,
				})
				.from(evidenceArtifacts)
				.innerJoin(evidences, eq(evidences.id, evidenceArtifacts.evidenceId))
				.leftJoin(users, eq(users.id, evidences.createdBy))
				.where(uploadedInOrg(args.orgId))
				.groupBy(evidences.createdBy, users.clerkUserId)
				.orderBy(desc(sql`coalesce(sum(${evidenceArtifacts.bytes}), 0)`))
				.limit(MAX_MEMBER_ROWS);
			const byMember = await Promise.all(
				memberRows.map(async (row) => {
					if (!row.clerkUserId) {
						return {
							userId: row.userId,
							name: "Unknown member",
							email: null,
							bytes: toNumber(row.bytes),
							artifactCount: toNumber(row.artifactCount),
							evidenceCount: toNumber(row.evidenceCount),
						};
					}
					const clerkUserId = row.clerkUserId;
					const profile = await resolveClerkUserProfile(
						input.runtime,
						clerkUserId,
					).catch(() => fallbackClerkUserProfile(clerkUserId));
					return {
						userId: row.userId,
						name: formatClerkDisplayName({ clerkUserId, ...profile }),
						email: profile.email,
						bytes: toNumber(row.bytes),
						artifactCount: toNumber(row.artifactCount),
						evidenceCount: toNumber(row.evidenceCount),
					};
				}),
			);

			const kindRows = await db
				.select({
					kind: evidenceArtifacts.kind,
					bytes: sql<number>`coalesce(sum(${evidenceArtifacts.bytes}), 0)`,
					artifactCount: sql<number>`count(${evidenceArtifacts.id})`,
				})
				.from(evidenceArtifacts)
				.innerJoin(evidences, eq(evidences.id, evidenceArtifacts.evidenceId))
				.where(uploadedInOrg(args.orgId))
				.groupBy(evidenceArtifacts.kind);
			const byKind = kindRows
				.map((row) => ({
					kind: row.kind as StorageArtifactKind,
					bytes: toNumber(row.bytes),
					artifactCount: toNumber(row.artifactCount),
				}))
				.sort((a, b) => b.bytes - a.bytes);

			// Added per bucket, from artifact creation times.
			const bucketFormat = granularity === "day" ? "%Y-%m-%d" : "%Y-%m";
			const bucketExpr = sql<string>`strftime(${bucketFormat}, ${evidenceArtifacts.createdAt} / 1000, 'unixepoch')`;
			const addedRows = await db
				.select({
					bucket: bucketExpr,
					bytes: sql<number>`coalesce(sum(${evidenceArtifacts.bytes}), 0)`,
					artifactCount: sql<number>`count(${evidenceArtifacts.id})`,
				})
				.from(evidenceArtifacts)
				.innerJoin(evidences, eq(evidences.id, evidenceArtifacts.evidenceId))
				.where(
					and(
						uploadedInOrg(args.orgId),
						gte(evidenceArtifacts.createdAt, rangeStart),
						lt(evidenceArtifacts.createdAt, rangeEnd),
					),
				)
				.groupBy(bucketExpr);
			const addedByBucket = new Map(
				addedRows.map((row) => [
					row.bucket,
					{
						bytes: toNumber(row.bytes),
						artifactCount: toNumber(row.artifactCount),
					},
				]),
			);
			const [baseRow] = await db
				.select({
					bytes: sql<number>`coalesce(sum(${evidenceArtifacts.bytes}), 0)`,
				})
				.from(evidenceArtifacts)
				.innerJoin(evidences, eq(evidences.id, evidenceArtifacts.evidenceId))
				.where(
					and(
						uploadedInOrg(args.orgId),
						lt(evidenceArtifacts.createdAt, rangeStart),
					),
				);

			// Stored per bucket: the last daily snapshot inside the bucket, else cumulative uploads.
			const snapshotRows = await db
				.select({
					day: organizationStorageDailyUsage.day,
					bytes: sql<number>`sum(${organizationStorageDailyUsage.bytes})`,
				})
				.from(organizationStorageDailyUsage)
				.where(
					and(
						eq(organizationStorageDailyUsage.orgId, args.orgId),
						gte(organizationStorageDailyUsage.day, utcDay(rangeStart)),
						lte(organizationStorageDailyUsage.day, utcDay(toDay)),
					),
				)
				.groupBy(organizationStorageDailyUsage.day)
				.orderBy(organizationStorageDailyUsage.day);
			const snapshotByBucket = new Map<string, number>();
			for (const row of snapshotRows) {
				const bucket = granularity === "day" ? row.day : row.day.slice(0, 7);
				snapshotByBucket.set(bucket, toNumber(row.bytes));
			}

			const today =
				granularity === "day" ? utcDay(generatedAt) : utcMonth(generatedAt);
			let cumulative = toNumber(baseRow?.bytes);
			const timeline = buckets.map((bucket) => {
				const added = addedByBucket.get(bucket) ?? {
					bytes: 0,
					artifactCount: 0,
				};
				cumulative += added.bytes;
				const storedBytes =
					bucket === today
						? toNumber(totalsRow?.bytes)
						: (snapshotByBucket.get(bucket) ?? cumulative);
				return {
					bucket,
					addedBytes: added.bytes,
					addedArtifacts: added.artifactCount,
					storedBytes,
				};
			});

			return {
				orgId: args.orgId,
				generatedAt,
				from: utcDay(rangeStart),
				to: utcDay(toDay),
				granularity,
				totals: {
					bytes: toNumber(totalsRow?.bytes),
					artifactCount: toNumber(totalsRow?.artifactCount),
					evidenceCount: toNumber(totalsRow?.evidenceCount),
					binBytes: toNumber(totalsRow?.binBytes),
				},
				byStorage,
				byMember,
				byKind,
				timeline,
			};
		},

		overview: async (args: {
			orgId: string;
			canManage: boolean;
		}): Promise<OrganizationStorageOverview> => {
			const [settings, usage, storageRows, transfers] = await Promise.all([
				getSettings(args.orgId),
				usageByStorage(args.orgId),
				db.query.organizationStorages.findMany({
					where: eq(organizationStorages.orgId, args.orgId),
					orderBy: organizationStorages.createdAt,
				}),
				db.query.organizationStorageTransfers.findMany({
					where: eq(organizationStorageTransfers.orgId, args.orgId),
					orderBy: desc(organizationStorageTransfers.createdAt),
					limit: 6,
				}),
			]);
			const active = transfers.find((transfer) =>
				(ACTIVE_TRANSFER_STATUSES as readonly string[]).includes(
					transfer.status,
				),
			);
			return {
				canManage: args.canManage,
				secretsAvailable: secretsAvailable(),
				settings,
				defaultStorageUsage: usage.get(null) ?? {
					bytes: 0,
					artifactCount: 0,
				},
				// Removed storages stay listed while artifacts still point at them.
				storages: storageRows
					.filter(
						(row) =>
							row.status === "active" ||
							(usage.get(row.id)?.artifactCount ?? 0) > 0,
					)
					.map((row) => publicStorage(row, usage.get(row.id))),
				activeTransfer: active ? publicTransfer(active) : null,
				recentTransfers: transfers
					.filter((transfer) => transfer.id !== active?.id)
					.map(publicTransfer),
			};
		},

		testConnection: async (args: {
			orgId: string;
			storageId?: string;
			fields?: StorageConnectionFields;
			credentials?: StorageCredentials;
		}): Promise<{ ok: true; verifiedAt: number }> => {
			if (args.storageId) {
				const row = await getActiveStorageRow(args.orgId, args.storageId);
				await assertEndpointAllowed(row.endpoint);
				try {
					await verifyStorageRoundTrip(
						await registry.forArtifact({ storageId: row.id }),
					);
				} catch (error) {
					throw new OrganizationStorageError(
						"STORAGE_CONNECTION_FAILED",
						`Could not write, read and delete a test object: ${
							error instanceof Error ? error.message : String(error)
						}`,
						422,
					);
				}
				const verifiedAt = now();
				await db
					.update(organizationStorages)
					.set({ lastVerifiedAt: verifiedAt })
					.where(eq(organizationStorages.id, row.id));
				return { ok: true, verifiedAt };
			}
			if (!args.fields || !args.credentials) {
				throw new OrganizationStorageError(
					"STORAGE_CONNECTION_REQUIRED",
					"Connection details are required",
					400,
				);
			}
			await verifyConnection(args.fields, args.credentials);
			return { ok: true, verifiedAt: now() };
		},

		createStorage: async (args: {
			orgId: string;
			actorUserId: string;
			name: string;
			fields: StorageConnectionFields;
			credentials: StorageCredentials;
			ipAddress?: string | null;
		}): Promise<OrganizationStorage> => {
			assertSecretsAvailable();
			const duplicate = await db.query.organizationStorages.findFirst({
				where: and(
					eq(organizationStorages.orgId, args.orgId),
					eq(organizationStorages.status, "active"),
					eq(organizationStorages.bucket, args.fields.bucket),
					nullableEquals(organizationStorages.endpoint, args.fields.endpoint),
					nullableEquals(organizationStorages.keyPrefix, args.fields.keyPrefix),
				),
				columns: { id: true },
			});
			if (duplicate) {
				throw new OrganizationStorageError(
					"STORAGE_ALREADY_CONFIGURED",
					"This bucket and prefix are already configured",
					409,
				);
			}
			await verifyConnection(args.fields, args.credentials);
			const id = createUuidV7();
			const sealed = await secrets.encrypt(
				args.orgId,
				{ kind: STORAGE_CREDENTIAL_KIND, id },
				{ ...args.credentials },
			);
			const timestamp = now();
			const [row] = await db
				.insert(organizationStorages)
				.values({
					id,
					orgId: args.orgId,
					name: args.name,
					...args.fields,
					credentialsEnc: sealed.enc,
					keyVersion: sealed.keyVersion,
					accessKeyLast4: args.credentials.accessKeyId.slice(-4),
					status: "active",
					lastVerifiedAt: timestamp,
					createdBy: args.actorUserId,
					createdAt: timestamp,
					updatedAt: timestamp,
				})
				.returning();
			if (!row) throw new Error("Failed to save storage");
			await recordOrganizationActivity(db, {
				organizationId: args.orgId,
				actorUserId: args.actorUserId,
				action: "organization.storage.created",
				entity: { type: "organization_storage", id },
				message: `Added storage ${args.name}`,
				metadata: {
					bucket: args.fields.bucket,
					endpoint: args.fields.endpoint,
					keyPrefix: args.fields.keyPrefix,
				},
				ipAddress: args.ipAddress ?? null,
			});
			return publicStorage(row, undefined);
		},

		updateStorage: async (args: {
			orgId: string;
			storageId: string;
			actorUserId: string;
			name?: string | undefined;
			fields: Partial<StorageConnectionFields>;
			credentials?: Partial<StorageCredentials>;
			ipAddress?: string | null;
		}): Promise<OrganizationStorage> => {
			const row = await getActiveStorageRow(args.orgId, args.storageId);
			const next: StorageConnectionFields = {
				endpoint:
					args.fields.endpoint === undefined
						? row.endpoint
						: args.fields.endpoint,
				region: args.fields.region ?? row.region,
				bucket: args.fields.bucket ?? row.bucket,
				keyPrefix:
					args.fields.keyPrefix === undefined
						? row.keyPrefix
						: args.fields.keyPrefix,
				forcePathStyle: args.fields.forcePathStyle ?? row.forcePathStyle,
				serverSideEncryption:
					args.fields.serverSideEncryption ?? row.serverSideEncryption,
			};
			const locationChanged =
				next.endpoint !== row.endpoint ||
				next.bucket !== row.bucket ||
				next.keyPrefix !== row.keyPrefix;
			if (locationChanged) {
				const impact = await storageArtifactCount(args.orgId, row.id);
				if (impact.artifactCount > 0) {
					throw new OrganizationStorageError(
						"STORAGE_IN_USE",
						"The endpoint, bucket and prefix cannot change while the storage holds evidence. Add a new storage and transfer instead.",
						409,
					);
				}
			}
			const credentialsChanged = Boolean(
				args.credentials?.accessKeyId || args.credentials?.secretAccessKey,
			);
			const connectionChanged =
				locationChanged ||
				credentialsChanged ||
				next.region !== row.region ||
				next.forcePathStyle !== row.forcePathStyle ||
				next.serverSideEncryption !== row.serverSideEncryption;

			let sealed: { enc: string; keyVersion: number } | null = null;
			let accessKeyLast4 = row.accessKeyLast4;
			if (connectionChanged) {
				assertSecretsAvailable();
				if (!row.credentialsEnc) {
					throw new OrganizationStorageError(
						"STORAGE_REMOVED",
						"This storage was removed",
						409,
					);
				}
				const current = await secrets.decryptStorageCredentials(
					row,
					row.credentialsEnc,
				);
				const credentials: StorageCredentials = {
					accessKeyId:
						args.credentials?.accessKeyId || current.accessKeyId || "",
					secretAccessKey:
						args.credentials?.secretAccessKey || current.secretAccessKey || "",
				};
				await verifyConnection(next, credentials);
				if (credentialsChanged) {
					sealed = await secrets.encrypt(
						args.orgId,
						{ kind: STORAGE_CREDENTIAL_KIND, id: row.id },
						{ ...credentials },
					);
					accessKeyLast4 = credentials.accessKeyId.slice(-4);
				}
			}
			const timestamp = now();
			const [updated] = await db
				.update(organizationStorages)
				.set({
					name: args.name ?? row.name,
					...next,
					...(sealed
						? { credentialsEnc: sealed.enc, keyVersion: sealed.keyVersion }
						: {}),
					accessKeyLast4,
					...(connectionChanged ? { lastVerifiedAt: timestamp } : {}),
					updatedAt: timestamp,
				})
				.where(eq(organizationStorages.id, row.id))
				.returning();
			if (!updated) throw new Error("Failed to update storage");
			registry.invalidate(row.id);
			await recordOrganizationActivity(db, {
				organizationId: args.orgId,
				actorUserId: args.actorUserId,
				action: "organization.storage.updated",
				entity: { type: "organization_storage", id: row.id },
				message: `Updated storage ${updated.name}`,
				metadata: {
					credentialsRotated: credentialsChanged,
					locationChanged,
				},
				ipAddress: args.ipAddress ?? null,
			});
			const usage = await usageByStorage(args.orgId);
			return publicStorage(updated, usage.get(row.id));
		},

		storageImpact: async (args: {
			orgId: string;
			storageId: string;
		}): Promise<StorageImpact> => {
			const row = await getStorageRow(args.orgId, args.storageId);
			return {
				storageId: row.id,
				...(await storageArtifactCount(args.orgId, row.id)),
			};
		},

		// Tombstones the storage. Artifacts that point at it stay listed but can no longer be read;
		// adding the same bucket again creates a new storage and never re-links them.
		deleteStorage: async (args: {
			orgId: string;
			storageId: string;
			actorUserId: string;
			confirmName: string;
			ipAddress?: string | null;
		}): Promise<StorageImpact> => {
			const row = await getActiveStorageRow(args.orgId, args.storageId);
			if (args.confirmName.trim() !== row.name) {
				throw new OrganizationStorageError(
					"STORAGE_DELETE_CONFIRMATION_MISMATCH",
					"Type the storage name to confirm",
					400,
				);
			}
			const settings = await getSettings(args.orgId);
			if (settings.defaultStorageId === row.id) {
				throw new OrganizationStorageError(
					"STORAGE_IS_WRITE_TARGET",
					"New evidence is saved to this storage. Choose another default storage first.",
					409,
				);
			}
			const transfer = await activeTransferFor(args.orgId);
			if (
				transfer &&
				(transfer.sourceStorageId === row.id ||
					transfer.targetStorageId === row.id)
			) {
				throw new OrganizationStorageError(
					"STORAGE_TRANSFER_ACTIVE",
					"A transfer is using this storage. Cancel it or wait for it to finish.",
					409,
				);
			}
			const impact = await storageArtifactCount(args.orgId, row.id);
			const timestamp = now();
			await db
				.update(organizationStorages)
				.set({
					status: "deleted",
					credentialsEnc: null,
					keyVersion: null,
					deletedAt: timestamp,
					deletedBy: args.actorUserId,
					updatedAt: timestamp,
				})
				.where(eq(organizationStorages.id, row.id));
			registry.invalidate(row.id);
			await recordOrganizationActivity(db, {
				organizationId: args.orgId,
				actorUserId: args.actorUserId,
				action: "organization.storage.deleted",
				entity: { type: "organization_storage", id: row.id },
				message:
					impact.artifactCount > 0
						? `Removed storage ${row.name}; ${impact.artifactCount} artifacts of ${impact.evidenceCount} evidences are no longer available`
						: `Removed storage ${row.name}`,
				metadata: { ...impact, bucket: row.bucket, endpoint: row.endpoint },
				ipAddress: args.ipAddress ?? null,
			});
			return { storageId: row.id, ...impact };
		},

		updateSettings: async (args: {
			orgId: string;
			actorUserId: string;
			defaultStorageId?: string | null | undefined;
			defaultStorageDisabled?: boolean | undefined;
			ipAddress?: string | null;
		}): Promise<StorageSettings> => {
			const current = await getSettings(args.orgId);
			const next: StorageSettings = {
				defaultStorageId:
					args.defaultStorageId === undefined
						? current.defaultStorageId
						: args.defaultStorageId,
				defaultStorageDisabled:
					args.defaultStorageDisabled ?? current.defaultStorageDisabled,
			};
			if (next.defaultStorageId) {
				await getActiveStorageRow(args.orgId, next.defaultStorageId);
			}
			if (next.defaultStorageDisabled && !next.defaultStorageId) {
				throw new OrganizationStorageError(
					"STORAGE_WRITE_TARGET_REQUIRED",
					"Choose one of your storages as the default before turning off JittleLamp storage",
					400,
				);
			}
			const timestamp = now();
			await db
				.insert(organizationStorageSettings)
				.values({
					orgId: args.orgId,
					...next,
					updatedBy: args.actorUserId,
					updatedAt: timestamp,
				})
				.onConflictDoUpdate({
					target: organizationStorageSettings.orgId,
					set: { ...next, updatedBy: args.actorUserId, updatedAt: timestamp },
				});
			await recordOrganizationActivity(db, {
				organizationId: args.orgId,
				actorUserId: args.actorUserId,
				action: "organization.storage.settings_updated",
				entity: {
					type: "organization_storage_settings",
					id: args.orgId,
				},
				message: next.defaultStorageDisabled
					? "Evidence is now saved only to the organization's own storage"
					: "Updated where new evidence is saved",
				metadata: { before: current, after: next },
				ipAddress: args.ipAddress ?? null,
			});
			return next;
		},
	};
};

export type OrganizationStorageService = ReturnType<
	typeof createOrganizationStorageService
>;

// Upserts today's stored bytes for every organisation and storage, including storages that
// dropped to zero since the previous snapshot. Run from the hourly maintenance loop.
export const recordStorageDailyUsage = async (
	db: BackendDb,
	now = Date.now(),
): Promise<number> => {
	const day = utcDay(now);
	const previousDay = utcDay(now - DAY_MS);
	const rows = await db
		.select({
			orgId: evidences.orgId,
			storageId: evidenceArtifacts.storageId,
			bytes: sql<number>`coalesce(sum(${evidenceArtifacts.bytes}), 0)`,
			artifactCount: sql<number>`count(${evidenceArtifacts.id})`,
		})
		.from(evidenceArtifacts)
		.innerJoin(evidences, eq(evidences.id, evidenceArtifacts.evidenceId))
		.where(eq(evidenceArtifacts.uploadStatus, "uploaded"))
		.groupBy(evidences.orgId, evidenceArtifacts.storageId);
	const current = new Map(
		rows.map((row) => [
			`${row.orgId}\u0000${row.storageId ?? DEFAULT_STORAGE_KEY}`,
			{
				orgId: row.orgId,
				storageKey: row.storageId ?? DEFAULT_STORAGE_KEY,
				bytes: toNumber(row.bytes),
				artifactCount: toNumber(row.artifactCount),
			},
		]),
	);
	const previous = await db.query.organizationStorageDailyUsage.findMany({
		where: and(
			gte(organizationStorageDailyUsage.day, previousDay),
			ne(organizationStorageDailyUsage.bytes, 0),
		),
		columns: { orgId: true, storageKey: true },
	});
	for (const row of previous) {
		const key = `${row.orgId}\u0000${row.storageKey}`;
		if (!current.has(key)) {
			current.set(key, {
				orgId: row.orgId,
				storageKey: row.storageKey,
				bytes: 0,
				artifactCount: 0,
			});
		}
	}
	for (const entry of current.values()) {
		await withBusyRetry(() =>
			db
				.insert(organizationStorageDailyUsage)
				.values({ ...entry, day, updatedAt: now })
				.onConflictDoUpdate({
					target: [
						organizationStorageDailyUsage.orgId,
						organizationStorageDailyUsage.storageKey,
						organizationStorageDailyUsage.day,
					],
					set: {
						bytes: entry.bytes,
						artifactCount: entry.artifactCount,
						updatedAt: now,
					},
				}),
		);
	}
	return current.size;
};
