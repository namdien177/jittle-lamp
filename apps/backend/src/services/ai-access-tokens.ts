import { Buffer } from "node:buffer";
import { and, eq, gt, isNull, or } from "drizzle-orm";

import { aiAccessTokens } from "../db/schema";
import type { BackendDb } from "./user-provisioning";

export const AI_ACCESS_TOKEN_SCOPE = "evidence:debug";
const AI_ACCESS_TOKEN_PREFIX = "jl_ai_";

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
	const tokenHash = await sha256Hex(token);
	const now = Date.now();
	const scopes = Array.from(
		new Set(input.scopes?.length ? input.scopes : [AI_ACCESS_TOKEN_SCOPE]),
	).join(" ");

	const [created] = await db
		.insert(aiAccessTokens)
		.values({
			userId: input.userId,
			label: input.label,
			tokenHash,
			tokenPrefix: token.slice(0, 14),
			scopes,
			createdAt: now,
			expiresAt: input.expiresAt,
		})
		.returning({
			id: aiAccessTokens.id,
			userId: aiAccessTokens.userId,
			label: aiAccessTokens.label,
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
			...created,
			scopes: parseScopes(created.scopes),
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

	const tokenHash = await sha256Hex(token);
	const now = Date.now();
	const row = await db.query.aiAccessTokens.findFirst({
		where: and(
			eq(aiAccessTokens.tokenHash, tokenHash),
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
