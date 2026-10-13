import {
	guardSql,
	parseSchemaAllowlist,
	type TestQuery,
	type TestQueryParam,
	testQueryParamSchema,
	type UpsertTestQueryRequest,
} from "@jittle-lamp/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod/v4";

import { testCredentials, testQueries } from "../db/schema";
import { conflict, HttpError, notFound } from "../http/test-http";
import { parseJsonColumn } from "./test-cases";
import type { BackendDb } from "./user-provisioning";

// Named SQL per postgres profile (roadmap 2026-10-13 §5.2 tier 3). A query is saved only when the
// shared guard accepts it against its profile's schema allowlist, so the runner replays reviewed
// statements the same way it would have refused unreviewed ones.

export type QueryRow = typeof testQueries.$inferSelect;
type CredentialRow = typeof testCredentials.$inferSelect;

const paramsSchema = z.array(testQueryParamSchema);
const fieldsSchema = z.record(z.string(), z.string());

export const toQuery = (row: QueryRow, profile: string): TestQuery => ({
	id: row.id,
	credentialId: row.credentialId,
	profile,
	name: row.name,
	sqlText: row.sqlText,
	params: parseJsonColumn(row.paramsJson, paramsSchema, []),
	createdBy: row.createdBy,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const postgresCredential = async (
	db: BackendDb,
	orgId: string,
	credentialId: string,
): Promise<CredentialRow> => {
	const row = await db.query.testCredentials.findFirst({
		where: and(
			eq(testCredentials.id, credentialId),
			eq(testCredentials.orgId, orgId),
			isNull(testCredentials.deletedAt),
		),
	});
	// The profile must exist in this organisation.
	if (!row) {
		throw notFound(
			"TEST_CREDENTIAL_NOT_FOUND",
			"No credential profile with that id",
		);
	}
	// Only a database profile can own a query; a login profile has nothing to run it on.
	if (row.kind !== "postgres") {
		throw notFound(
			"TEST_CREDENTIAL_NOT_FOUND",
			"No postgres credential profile with that id",
		);
	}
	return row;
};

export const credentialAllowlist = (row: CredentialRow): string[] =>
	parseSchemaAllowlist(
		parseJsonColumn(row.fieldsJson, fieldsSchema, {}).schema_allowlist,
	);

// The guard's findings for an editor, without saving anything.
export const checkQuerySql = (
	sqlText: string,
	schemaAllowlist: readonly string[],
): string[] => {
	const result = guardSql(sqlText, { schemaAllowlist });
	return result.ok ? [] : result.errors;
};

export const listQueries = async (
	db: BackendDb,
	orgId: string,
	filter: { credentialId?: string | undefined } = {},
): Promise<TestQuery[]> => {
	const rows = await db.query.testQueries.findMany({
		where: and(
			eq(testQueries.orgId, orgId),
			isNull(testQueries.deletedAt),
			...(filter.credentialId
				? [eq(testQueries.credentialId, filter.credentialId)]
				: []),
		),
		orderBy: [asc(testQueries.name)],
	});
	const credentialIds = [...new Set(rows.map((row) => row.credentialId))];
	const credentials =
		credentialIds.length > 0
			? await db.query.testCredentials.findMany({
					where: inArray(testCredentials.id, credentialIds),
				})
			: [];
	const profiles = new Map(credentials.map((row) => [row.id, row.profile]));
	return rows.map((row) =>
		toQuery(row, profiles.get(row.credentialId) ?? "unknown"),
	);
};

export const getQueryRow = async (
	db: BackendDb,
	orgId: string,
	id: string,
): Promise<QueryRow> => {
	const row = await db.query.testQueries.findFirst({
		where: and(
			eq(testQueries.id, id),
			eq(testQueries.orgId, orgId),
			isNull(testQueries.deletedAt),
		),
	});
	if (!row)
		throw notFound("TEST_QUERY_NOT_FOUND", "No saved query with that id");
	return row;
};

const isUniqueViolation = (error: unknown) =>
	/UNIQUE constraint failed/i.test(
		String((error as { cause?: unknown })?.cause ?? error),
	);

export const saveQuery = async (
	db: BackendDb,
	input: {
		orgId: string;
		userId: string;
		id?: string;
		request: UpsertTestQueryRequest;
	},
): Promise<{ row: QueryRow; profile: string }> => {
	const credential = await postgresCredential(
		db,
		input.orgId,
		input.request.credentialId,
	);
	const errors = checkQuerySql(
		input.request.sqlText,
		credentialAllowlist(credential),
	);
	if (errors.length > 0) {
		throw new HttpError(
			422,
			"TEST_QUERY_REJECTED",
			`The statement was refused: ${errors.join(" ")}`,
			{ errors },
		);
	}
	// Every `$n` the statement uses must have a declared parameter, and no more.
	const placeholders = new Set(
		(input.request.sqlText.match(/\$(\d+)/g) ?? []).map((token) =>
			Number(token.slice(1)),
		),
	);
	const highest = placeholders.size > 0 ? Math.max(...placeholders) : 0;
	if (highest !== input.request.params.length) {
		throw new HttpError(
			422,
			"TEST_QUERY_PARAMS_MISMATCH",
			`The statement uses ${highest} placeholder(s) but ${input.request.params.length} param(s) are declared`,
		);
	}
	const now = Date.now();
	const values = {
		credentialId: credential.id,
		name: input.request.name,
		sqlText: input.request.sqlText.trim(),
		paramsJson: JSON.stringify(input.request.params satisfies TestQueryParam[]),
		updatedAt: now,
	};
	try {
		if (input.id) {
			const [row] = await db
				.update(testQueries)
				.set(values)
				.where(
					and(eq(testQueries.id, input.id), eq(testQueries.orgId, input.orgId)),
				)
				.returning();
			if (!row)
				throw notFound("TEST_QUERY_NOT_FOUND", "No saved query with that id");
			return { row, profile: credential.profile };
		}
		const [row] = await db
			.insert(testQueries)
			.values({
				...values,
				orgId: input.orgId,
				createdBy: input.userId,
				createdAt: now,
			})
			.returning();
		if (!row) throw new Error("insert returned no row");
		return { row, profile: credential.profile };
	} catch (error) {
		if (isUniqueViolation(error)) {
			throw conflict(
				"TEST_QUERY_NAME_TAKEN",
				`${credential.profile} already has a query named ${input.request.name}`,
			);
		}
		throw error;
	}
};

export const deleteQuery = async (
	db: BackendDb,
	input: { orgId: string; userId: string; id: string },
): Promise<void> => {
	const row = await getQueryRow(db, input.orgId, input.id);
	await db
		.update(testQueries)
		.set({ deletedAt: Date.now(), deletedBy: input.userId })
		.where(eq(testQueries.id, row.id));
};

// The saved queries a run may use: those of the postgres profiles its config resolved.
export const queriesForProfiles = async (
	db: BackendDb,
	orgId: string,
	credentialIds: readonly string[],
): Promise<
	Array<{
		profile: string;
		name: string;
		sqlText: string;
		params: TestQueryParam[];
	}>
> => {
	if (credentialIds.length === 0) return [];
	const queries = await listQueries(db, orgId);
	return queries
		.filter((query) => credentialIds.includes(query.credentialId))
		.map((query) => ({
			profile: query.profile,
			name: query.name,
			sqlText: query.sqlText,
			params: query.params,
		}));
};
