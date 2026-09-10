import { eq } from "drizzle-orm";

import { users } from "../db/schema";
import type { AuthContext } from "../plugins/clerk-auth";
import {
	AI_MCP_TOKEN_SCOPE,
	recordAiAccessTokenUsage,
	type VerifiedAiAccessToken,
	verifyAiAccessToken,
} from "./ai-access-tokens";
import { getRequestIpAddress } from "./organization-activity";
import type { BackendDb } from "./user-provisioning";

// Keep this list explicit. New user endpoints must be reviewed before an AI
// token can call them, especially account credentials and organization settings.
const aiUserRoutes: ReadonlyArray<{
	methods: readonly string[];
	path: RegExp;
}> = [
	{ methods: ["POST"], path: /^\/automation\/evidences\/zip\/?$/ },
	{ methods: ["GET"], path: /^\/protected\/me\/?$/ },
	{ methods: ["GET"], path: /^\/orgs\/?$/ },
	{
		methods: ["POST"],
		path: /^\/orgs\/[^/%?#]+\/select-active\/?$/,
	},
	{ methods: ["GET"], path: /^\/evidences\/?$/ },
	{ methods: ["GET"], path: /^\/evidences\/tags\/?$/ },
	{ methods: ["GET", "PATCH", "DELETE"], path: /^\/evidences\/[^/%?#]+\/?$/ },
	{
		methods: ["GET", "POST"],
		path: /^\/evidences\/[^/%?#]+\/comments\/?$/,
	},
	{ methods: ["POST"], path: /^\/evidences\/bulk-delete\/?$/ },
	{ methods: ["POST"], path: /^\/evidences\/[^/%?#]+\/(?:copy|move)\/?$/ },
	{ methods: ["PATCH"], path: /^\/evidences\/[^/%?#]+\/tags\/?$/ },
	{
		methods: ["GET"],
		path: /^\/evidences\/[^/%?#]+\/(?:playback|artifacts)\/?$/,
	},
	{
		methods: ["GET"],
		path: /^\/evidences\/[^/%?#]+\/artifacts\/[^/%?#]+\/read-url\/?$/,
	},
	{
		methods: ["GET", "POST"],
		path: /^\/evidences\/[^/%?#]+\/share-links\/?$/,
	},
	{ methods: ["POST"], path: /^\/share-links\/[^/%?#]+\/revoke\/?$/ },
	{ methods: ["GET"], path: /^\/share-links\/[^/%?#]+\/resolve\/?$/ },
	{
		methods: ["POST"],
		path: /^\/evidences\/(?:uploads|manual-uploads)\/start\/?$/,
	},
	{
		methods: ["POST"],
		path: /^\/evidences\/desktop-sessions\/sync\/start\/?$/,
	},
	{ methods: ["PUT"], path: /^\/evidences\/uploads\/[^/%?#]+\/blob\/?$/ },
	{
		methods: ["POST"],
		path: /^\/evidences\/uploads\/[^/%?#]+\/complete\/?$/,
	},
];

export const isAiUserRouteAllowed = (method: string, path: string): boolean => {
	// /evidences/:id also matches "tags". Tag definitions belong to settings;
	// assigning existing tags to an evidence remains an ordinary evidence action.
	if (path.replace(/\/$/, "") === "/evidences/tags" && method !== "GET") {
		return false;
	}
	return aiUserRoutes.some(
		(route) => route.methods.includes(method) && route.path.test(path),
	);
};

export const readAiBearerToken = (request: Request): string | null => {
	const authorization = request.headers.get("authorization");
	if (!authorization?.startsWith("Bearer ")) return null;
	const token = authorization.slice("Bearer ".length).trim();
	return token.startsWith("jl_ai_") ? token : null;
};

export type AiUserAccessResult =
	| { ok: true; authContext: AuthContext; token: VerifiedAiAccessToken }
	| { ok: false; status: 401 | 403; code: string; message: string };

export const verifyAiUserAccess = async (
	db: BackendDb,
	request: Request,
): Promise<AiUserAccessResult> => {
	const bearer = readAiBearerToken(request);
	if (!bearer) {
		return {
			ok: false,
			status: 401,
			code: "AI_AUTH_UNAUTHENTICATED",
			message: "AI access token required",
		};
	}
	const token = await verifyAiAccessToken(db, bearer);
	if (!token) {
		return {
			ok: false,
			status: 401,
			code: "AI_AUTH_INVALID_TOKEN",
			message: "Invalid or expired AI access token",
		};
	}
	if (!token.scopes.includes(AI_MCP_TOKEN_SCOPE)) {
		return {
			ok: false,
			status: 403,
			code: "AI_AUTH_INSUFFICIENT_SCOPE",
			message: "This AI access token requires MCP access",
		};
	}

	const owner = await db.query.users.findFirst({
		where: eq(users.id, token.userId),
		columns: { id: true, clerkUserId: true, activeOrgId: true },
		with: {
			organizationMemberships: {
				columns: { organizationId: true, teamId: true },
				with: { organization: { columns: { isPersonal: true } } },
			},
		},
	});
	if (!owner) {
		return {
			ok: false,
			status: 401,
			code: "AI_AUTH_INVALID_TOKEN",
			message: "Invalid or expired AI access token",
		};
	}

	const path = new URL(request.url).pathname;
	await recordAiAccessTokenUsage(db, {
		tokenId: token.id,
		userId: owner.id,
		method: request.method,
		path,
		ipAddress: getRequestIpAddress(request),
		userAgent: request.headers.get("user-agent")?.trim() || null,
	});
	if (!isAiUserRouteAllowed(request.method, path)) {
		return {
			ok: false,
			status: 403,
			code: "AI_ACTION_FORBIDDEN",
			message: "AI access does not permit this account or organization action",
		};
	}

	const memberships = owner.organizationMemberships.filter(
		(membership) => membership.teamId === null,
	);
	const activeOrgId =
		memberships.find(
			(membership) => membership.organizationId === owner.activeOrgId,
		)?.organizationId ??
		memberships.find((membership) => membership.organization.isPersonal)
			?.organizationId ??
		memberships[0]?.organizationId ??
		null;

	return {
		ok: true,
		token,
		authContext: {
			userId: owner.clerkUserId,
			localUserId: owner.id,
			orgId: null,
			activeOrgId,
			roles: [],
			scopes: [
				...token.scopes,
				"evidence:read",
				"evidence:write",
				"evidence:manage",
				"share:write",
				"org:read",
			],
			tokenType: "ai",
		},
	};
};
