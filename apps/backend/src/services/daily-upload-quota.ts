import { and, eq, gte, isNull, ne, or, sql } from "drizzle-orm";

import { evidenceArtifacts, evidences, organizations } from "../db/schema";
import type { BackendDb } from "./user-provisioning";

// Daily cap on bytes added to the JittleLamp default storage. Organisations writing to their own
// storage are not limited. Hard-coded until limits come from config or subscription tiers.
export const PERSONAL_DAILY_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
export const ORGANIZATION_DAILY_UPLOAD_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;

// Upload sessions that never received their blob stop counting once they expire.
// Keep in step with UPLOAD_SESSION_TTL_MS in routes/evidence-uploads.ts.
const ABANDONED_UPLOAD_AFTER_MS = 5 * 60 * 1000;

type QuotaExecutor = Pick<BackendDb, "select">;

export type DailyUploadQuota = {
	limitBytes: number;
	usedBytes: number;
	// Start of the current UTC day; the quota resets at the next one.
	windowStart: number;
	resetsAt: number;
};

export class DailyUploadQuotaExceededError extends Error {
	constructor(
		readonly quota: DailyUploadQuota,
		readonly requestedBytes: number,
	) {
		super("Daily upload limit reached for this organization");
		this.name = "DailyUploadQuotaExceededError";
	}
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const startOfUtcDay = (now: number) => now - (now % DAY_MS);

const formatMegabytes = (bytes: number) => {
	const value = bytes / (1024 * 1024);
	return `${Number.isInteger(value) ? value : value.toFixed(1)} MB`;
};

export const formatDailyUploadQuotaMessage = (quota: DailyUploadQuota) =>
	`Daily upload limit of ${formatMegabytes(quota.limitBytes)} reached for this organization (${formatMegabytes(quota.usedBytes)} used today); it resets at 00:00 UTC`;

export const getDailyUploadQuota = async (
	db: QuotaExecutor,
	orgId: string,
	now = Date.now(),
): Promise<DailyUploadQuota> => {
	const windowStart = startOfUtcDay(now);
	const [org] = await db
		.select({ isPersonal: organizations.isPersonal })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.limit(1);
	const limitBytes =
		org?.isPersonal === false
			? ORGANIZATION_DAILY_UPLOAD_LIMIT_BYTES
			: PERSONAL_DAILY_UPLOAD_LIMIT_BYTES;

	// Bytes added to the default storage today, including evidence deleted since: the limit caps
	// ingress, not the total.
	const [usage] = await db
		.select({
			usedBytes: sql<number>`coalesce(sum(${evidenceArtifacts.bytes}), 0)`,
		})
		.from(evidenceArtifacts)
		.innerJoin(evidences, eq(evidences.id, evidenceArtifacts.evidenceId))
		.where(
			and(
				eq(evidences.orgId, orgId),
				isNull(evidenceArtifacts.storageId),
				gte(evidenceArtifacts.createdAt, windowStart),
				ne(evidenceArtifacts.uploadStatus, "failed"),
				or(
					ne(evidenceArtifacts.uploadStatus, "uploading"),
					gte(evidenceArtifacts.createdAt, now - ABANDONED_UPLOAD_AFTER_MS),
				),
			),
		);

	return {
		limitBytes,
		usedBytes: Number(usage?.usedBytes ?? 0),
		windowStart,
		resetsAt: windowStart + DAY_MS,
	};
};

// Throws when adding `additionalBytes` to the default storage would exceed today's limit; a no-op
// for bytes going to the organisation's own storage (`storageId` set). Inside a transaction, call
// it after the first write so concurrent uploads to the same database serialise on the write lock.
export const assertDailyUploadQuota = async (
	db: QuotaExecutor,
	input: {
		orgId: string;
		storageId: string | null;
		additionalBytes: number;
		now?: number;
	},
) => {
	if (input.storageId !== null) {
		return null;
	}
	const quota = await getDailyUploadQuota(db, input.orgId, input.now);
	if (
		input.additionalBytes > 0 &&
		quota.usedBytes + input.additionalBytes > quota.limitBytes
	) {
		throw new DailyUploadQuotaExceededError(quota, input.additionalBytes);
	}
	return quota;
};
