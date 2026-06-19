import { Buffer } from "node:buffer";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";

import {
	aiAccessTokens,
	aiAccessTokenUsageLogs,
	createAiAccessTokenUsageLogInputSchema,
} from "../db/schema";
import type { BackendDb } from "./user-provisioning";

export const AI_ACCESS_TOKEN_SCOPE = "evidence:debug";
export const AI_ACCESS_TOKEN_USAGE_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;
const AI_ACCESS_TOKEN_PREFIX = "jl_ai_";
export const AI_ACCESS_TOKEN_VERSION_V1 = "v1";
export const AI_ACCESS_TOKEN_VERSION_V2 = "v2";

export type VerifiedAiAccessToken = {
	id: string;
	userId: string;
	label: string;
	scopes: string[];
	expiresAt: number | null;
};

const sha256Hex = async (value: string): Promise<string> => {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest))
		.map((part) => part.toString(16).padStart(2, "0"))
		.join("");
};

const parseScopes = (value: string): string[] =>
	value
		.split(" ")
		.map((scope) => scope.trim())
		.filter(Boolean);

export const createAiAccessTokenSecret = (): string => {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return `${AI_ACCESS_TOKEN_PREFIX}${Buffer.from(bytes).toString("base64url")}`;
};

export const createAiAccessToken = async (
	db: BackendDb,
	input: {
		userId: string;
		label: string;
		expiresAt: number | null;
		scopes?: readonly string[];
	},
) => {
	const token = createAiAccessTokenSecret();
	const now = Date.now();
	const scopes = Array.from(
		new Set(input.scopes?.length ? input.scopes : [AI_ACCESS_TOKEN_SCOPE]),
	).join(" ");

	const [created] = await db
		.insert(aiAccessTokens)
		.values({
			userId: input.userId,
			label: input.label,
			tokenSecret: token,
			tokenVersion: AI_ACCESS_TOKEN_VERSION_V2,
			tokenPrefix: token.slice(0, 14),
			scopes,
			createdAt: now,
			expiresAt: input.expiresAt,
		})
		.returning({
			id: aiAccessTokens.id,
			userId: aiAccessTokens.userId,
			label: aiAccessTokens.label,
			tokenSecret: aiAccessTokens.tokenSecret,
			tokenVersion: aiAccessTokens.tokenVersion,
			tokenPrefix: aiAccessTokens.tokenPrefix,
			scopes: aiAccessTokens.scopes,
			createdAt: aiAccessTokens.createdAt,
			expiresAt: aiAccessTokens.expiresAt,
			lastUsedAt: aiAccessTokens.lastUsedAt,
			revokedAt: aiAccessTokens.revokedAt,
		});

	if (!created) {
		throw new Error("Failed to create AI access token");
	}

	return {
		token,
		accessToken: {
			id: created.id,
			userId: created.userId,
			label: created.label,
			token,
			tokenVersion: AI_ACCESS_TOKEN_VERSION_V2 as "v2",
			tokenPrefix: created.tokenPrefix,
			scopes: parseScopes(created.scopes),
			createdAt: created.createdAt,
			expiresAt: created.expiresAt,
			lastUsedAt: created.lastUsedAt,
			revokedAt: created.revokedAt,
		},
	};
};

export const verifyAiAccessToken = async (
	db: BackendDb,
	token: string,
): Promise<VerifiedAiAccessToken | null> => {
	if (!token.startsWith(AI_ACCESS_TOKEN_PREFIX) || token.length < 24) {
		return null;
	}

	const now = Date.now();
	let row = await db.query.aiAccessTokens.findFirst({
		where: and(
			eq(aiAccessTokens.tokenSecret, token),
			eq(aiAccessTokens.tokenVersion, AI_ACCESS_TOKEN_VERSION_V2),
			isNull(aiAccessTokens.revokedAt),
			or(isNull(aiAccessTokens.expiresAt), gt(aiAccessTokens.expiresAt, now)),
		),
		columns: {
			id: true,
			userId: true,
			label: true,
			scopes: true,
			expiresAt: true,
		},
	});
	if (!row) {
		const tokenHash = await sha256Hex(token);
		row = await db.query.aiAccessTokens.findFirst({
			where: and(
				eq(aiAccessTokens.tokenHash, tokenHash),
				eq(aiAccessTokens.tokenVersion, AI_ACCESS_TOKEN_VERSION_V1),
				isNull(aiAccessTokens.revokedAt),
				or(isNull(aiAccessTokens.expiresAt), gt(aiAccessTokens.expiresAt, now)),
			),
			columns: {
				id: true,
				userId: true,
				label: true,
				scopes: true,
				expiresAt: true,
			},
		});
	}
	if (!row) {
		return null;
	}

	await db
		.update(aiAccessTokens)
		.set({ lastUsedAt: now })
		.where(eq(aiAccessTokens.id, row.id));

	return {
		id: row.id,
		userId: row.userId,
		label: row.label,
		scopes: parseScopes(row.scopes),
		expiresAt: row.expiresAt,
	};
};

export const revokeAiAccessToken = async (
	db: BackendDb,
	input: { tokenId: string; userId: string },
): Promise<boolean> => {
	const [revoked] = await db
		.update(aiAccessTokens)
		.set({ revokedAt: Date.now() })
		.where(
			and(
				eq(aiAccessTokens.id, input.tokenId),
				eq(aiAccessTokens.userId, input.userId),
				isNull(aiAccessTokens.revokedAt),
			),
		)
		.returning({ id: aiAccessTokens.id });

	return Boolean(revoked);
};

export const cleanupExpiredAiAccessTokenUsageLogs = async (
	db: BackendDb,
	now = Date.now(),
	retentionMs = AI_ACCESS_TOKEN_USAGE_RETENTION_MS,
): Promise<number> => {
	const cutoff = now - retentionMs;
	const removed = await db
		.delete(aiAccessTokenUsageLogs)
		.where(lt(aiAccessTokenUsageLogs.createdAt, cutoff))
		.returning({ id: aiAccessTokenUsageLogs.id });
	return removed.length;
};

export const recordAiAccessTokenUsage = async (
	db: BackendDb,
	input: {
		tokenId: string;
		userId: string;
		evidenceId?: string | null;
		method: string;
		path: string;
		ipAddress?: string | null;
		userAgent?: string | null;
		now?: number;
	},
): Promise<void> => {
	const now = input.now ?? Date.now();
	const parsed = createAiAccessTokenUsageLogInputSchema.parse({
		tokenId: input.tokenId,
		userId: input.userId,
		evidenceId: input.evidenceId ?? null,
		method: input.method,
		path: input.path,
		ipAddress: input.ipAddress ?? null,
		userAgent: input.userAgent ?? null,
		createdAt: now,
	});

	await db.insert(aiAccessTokenUsageLogs).values(parsed);
	await cleanupExpiredAiAccessTokenUsageLogs(db, now);
};
