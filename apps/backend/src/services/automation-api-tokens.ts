import { Buffer } from "node:buffer";
import { and, eq, gt, isNull, or } from "drizzle-orm";

import { automationApiTokens } from "../db/schema";
import type { BackendDb } from "./user-provisioning";

export const AUTOMATION_API_TOKEN_SCOPE = "evidence:upload";
const AUTOMATION_API_TOKEN_PREFIX = "jl_api_";

export type VerifiedAutomationApiToken = {
	id: string;
	userId: string;
	orgId: string;
	label: string;
	scopes: string[];
	expiresAt: number | null;
};

const parseScopes = (value: string): string[] =>
	value
		.split(" ")
		.map((scope) => scope.trim())
		.filter(Boolean);

export const createAutomationApiTokenSecret = (): string => {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return `${AUTOMATION_API_TOKEN_PREFIX}${Buffer.from(bytes).toString("base64url")}`;
};

export const createAutomationApiToken = async (
	db: BackendDb,
	input: {
		userId: string;
		orgId: string;
		label: string;
		expiresAt: number | null;
		scopes?: readonly string[];
	},
) => {
	const token = createAutomationApiTokenSecret();
	const now = Date.now();
	const scopes = Array.from(
		new Set(input.scopes?.length ? input.scopes : [AUTOMATION_API_TOKEN_SCOPE]),
	).join(" ");

	const [created] = await db
		.insert(automationApiTokens)
		.values({
			userId: input.userId,
			orgId: input.orgId,
			label: input.label,
			tokenSecret: token,
			tokenPrefix: token.slice(0, 15),
			scopes,
			createdAt: now,
			expiresAt: input.expiresAt,
		})
		.returning({
			id: automationApiTokens.id,
			userId: automationApiTokens.userId,
			orgId: automationApiTokens.orgId,
			label: automationApiTokens.label,
			tokenSecret: automationApiTokens.tokenSecret,
			tokenPrefix: automationApiTokens.tokenPrefix,
			scopes: automationApiTokens.scopes,
			createdAt: automationApiTokens.createdAt,
			expiresAt: automationApiTokens.expiresAt,
			lastUsedAt: automationApiTokens.lastUsedAt,
			revokedAt: automationApiTokens.revokedAt,
		});

	if (!created) {
		throw new Error("Failed to create automation API token");
	}

	return {
		token,
		apiToken: {
			id: created.id,
			userId: created.userId,
			orgId: created.orgId,
			label: created.label,
			token: created.tokenSecret,
			tokenPrefix: created.tokenPrefix,
			scopes: parseScopes(created.scopes),
			createdAt: created.createdAt,
			expiresAt: created.expiresAt,
			lastUsedAt: created.lastUsedAt,
			revokedAt: created.revokedAt,
		},
	};
};

export const verifyAutomationApiToken = async (
	db: BackendDb,
	token: string,
): Promise<VerifiedAutomationApiToken | null> => {
	if (!token.startsWith(AUTOMATION_API_TOKEN_PREFIX) || token.length < 24) {
		return null;
	}

	const now = Date.now();
	const row = await db.query.automationApiTokens.findFirst({
		where: and(
			eq(automationApiTokens.tokenSecret, token),
			isNull(automationApiTokens.revokedAt),
			or(
				isNull(automationApiTokens.expiresAt),
				gt(automationApiTokens.expiresAt, now),
			),
		),
		columns: {
			id: true,
			userId: true,
			orgId: true,
			label: true,
			scopes: true,
			expiresAt: true,
		},
	});
	if (!row) {
		return null;
	}

	await db
		.update(automationApiTokens)
		.set({ lastUsedAt: now })
		.where(eq(automationApiTokens.id, row.id));

	return {
		id: row.id,
		userId: row.userId,
		orgId: row.orgId,
		label: row.label,
		scopes: parseScopes(row.scopes),
		expiresAt: row.expiresAt,
	};
};

export const revokeAutomationApiToken = async (
	db: BackendDb,
	input: { tokenId: string; userId: string },
): Promise<boolean> => {
	const [revoked] = await db
		.update(automationApiTokens)
		.set({ revokedAt: Date.now() })
		.where(
			and(
				eq(automationApiTokens.id, input.tokenId),
				eq(automationApiTokens.userId, input.userId),
				isNull(automationApiTokens.revokedAt),
			),
		)
		.returning({ id: automationApiTokens.id });

	return Boolean(revoked);
};
