import type { Logger } from "pino";
import type { z } from "zod/v4";

import type { RuntimeConfig } from "../config/runtime";
import { resolveRequestAuthContext } from "../plugins/clerk-auth";
import { verifyAutomationApiToken } from "../services/automation-api-tokens";
import type { TestPermission } from "../services/test-case-policy";
import { testCasePolicy } from "../services/test-case-policy";
import type { BackendDb } from "../services/user-provisioning";
import { createApiError } from "./api-error";

// Helpers shared by the test-case, test-run, test-config and runner-pool routes. Request and
// response payloads are validated with the Zod contract in @jittle-lamp/shared/test-api.

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly extra: Record<string, unknown> = {},
		readonly headers: Record<string, string> = {},
	) {
		super(message);
		this.name = "HttpError";
	}
}

export const notFound = (code: string, message: string) =>
	new HttpError(404, code, message);
export const forbidden = (code: string, message: string) =>
	new HttpError(403, code, message);
export const conflict = (
	code: string,
	message: string,
	extra: Record<string, unknown> = {},
) => new HttpError(409, code, message, extra);

type RouteContext = {
	requestId: string;
	set: { status?: number | string; headers: Record<string, unknown> };
};

// Runs a handler and turns HttpError into the standard error envelope.
export const handleTestRoute = async <T>(
	context: RouteContext,
	run: () => Promise<T>,
): Promise<T | ReturnType<typeof createApiError>> => {
	try {
		return await run();
	} catch (error) {
		if (error instanceof HttpError) {
			context.set.status = error.status;
			for (const [name, value] of Object.entries(error.headers)) {
				context.set.headers[name] = value;
			}
			return {
				...createApiError(
					context.requestId,
					error.code,
					error.message,
					error.status,
				),
				...error.extra,
			};
		}
		// Secrets service errors (services/test-config.ts), matched by name to avoid a cycle.
		const name = error instanceof Error ? error.name : "";
		if (name === "SecretsUnavailableError") {
			context.set.status = 503;
			return createApiError(
				context.requestId,
				"SECRETS_MASTER_KEY_MISSING",
				(error as Error).message,
				503,
			);
		}
		if (name === "SecretDecryptionError") {
			context.set.status = 500;
			return createApiError(
				context.requestId,
				"SECRET_DECRYPTION_FAILED",
				"A stored secret could not be decrypted with the configured master key",
				500,
			);
		}
		throw error;
	}
};

export const requireDb = (db: BackendDb | null): BackendDb => {
	if (!db)
		throw new HttpError(503, "DB_UNAVAILABLE", "Database is unavailable");
	return db;
};

const describeZodError = (error: z.ZodError): string =>
	error.issues
		.slice(0, 5)
		.map(
			(issue) =>
				`${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`,
		)
		.join("; ");

export const parseInput = <S extends z.ZodType>(
	schema: S,
	value: unknown,
): z.output<S> => {
	const result = schema.safeParse(value ?? {});
	if (!result.success) {
		throw new HttpError(422, "VALIDATION", describeZodError(result.error));
	}
	return result.data;
};

// Responses go through the contract schema so a drift is a server error, not a silent change.
export const respond = <S extends z.ZodType>(
	schema: S,
	value: z.input<S>,
): z.output<S> => schema.parse(value);

const listKeys = new Set([
	"status",
	"tags",
	"source",
	"lastOutcome",
	"ids",
	"memberIds",
]);

// Query parameters that are numbers or booleans in the route schemas. Everything else stays a
// string, so a search for "true" or a title of "2024" is not turned into a boolean or a number.
export const numericQueryKeys: ReadonlySet<string> = new Set([
	"limit",
	"noRunsSinceDays",
	"from",
	"to",
]);
export const booleanQueryKeys: ReadonlySet<string> = new Set([
	"staleCache",
	"mine",
	"unreadOnly",
	"withSecrets",
	"all",
]);

// Query strings carry arrays as repeated keys or comma lists, numbers and booleans as text.
export const normalizeQuery = (
	url: string,
	arrayKeys: ReadonlySet<string> = listKeys,
): Record<string, unknown> => {
	const params = new URL(url).searchParams;
	const out: Record<string, unknown> = {};
	for (const key of new Set(params.keys())) {
		const values = params
			.getAll(key)
			.flatMap((value) => (arrayKeys.has(key) ? value.split(",") : [value]))
			.map((value) => value.trim())
			.filter((value) => value.length > 0);
		if (arrayKeys.has(key)) {
			out[key] = values;
			continue;
		}
		const value = values[0];
		if (value === undefined) continue;
		if (booleanQueryKeys.has(key) && (value === "true" || value === "false"))
			out[key] = value === "true";
		else if (numericQueryKeys.has(key) && /^-?\d+(?:\.\d+)?$/.test(value))
			out[key] = Number(value);
		else out[key] = value;
	}
	return out;
};

export const readBearer = (request: Request): string | null => {
	const header = request.headers.get("authorization");
	if (!header?.startsWith("Bearer ")) return null;
	const token = header.slice("Bearer ".length).trim();
	return token.length > 0 ? token : null;
};

export type TestActor = {
	kind: "session" | "ai" | "automation";
	userId: string;
	orgId: string;
	tokenId: string | null;
};

type ActorContext = RouteContext & {
	db: BackendDb | null;
	request: Request;
	requestLogger: Logger;
	runtime: RuntimeConfig;
};

// Resolves who is calling a test route: a signed-in session, a jl_ai_ token (route allowlist in
// ai-user-access.ts) or, where the route allows it, a jl_api_ automation token scoped to its
// organisation. The owner's role permissions apply to every kind.
export const resolveTestActor = async (
	context: ActorContext,
	options: { automation?: boolean } = {},
): Promise<TestActor> => {
	const db = requireDb(context.db);
	const bearer = readBearer(context.request);
	if (bearer?.startsWith("jl_api_")) {
		if (!options.automation) {
			throw new HttpError(
				403,
				"AUTOMATION_ACTION_FORBIDDEN",
				"Automation API tokens cannot call this route",
			);
		}
		const token = await verifyAutomationApiToken(db, bearer);
		if (!token) {
			throw new HttpError(
				401,
				"AUTOMATION_AUTH_INVALID_TOKEN",
				"Invalid or expired automation API token",
			);
		}
		return {
			kind: "automation",
			userId: token.userId,
			orgId: token.orgId,
			tokenId: token.id,
		};
	}
	const result = await resolveRequestAuthContext({
		db,
		request: context.request,
		requestId: context.requestId,
		requestLogger: context.requestLogger,
		runtime: context.runtime,
	});
	if (!result.ok) {
		throw new HttpError(
			result.status,
			result.body.error.code,
			result.body.error.message,
		);
	}
	const { authContext } = result;
	if (!authContext.localUserId || !authContext.activeOrgId) {
		throw new HttpError(
			403,
			"TEST_ACCOUNT_REQUIRED",
			"A workspace account with an active organisation is required",
		);
	}
	return {
		kind: authContext.tokenType === "ai" ? "ai" : "session",
		userId: authContext.localUserId,
		orgId: authContext.activeOrgId,
		// AI tokens (jl_ai_) get their own run-request bucket, like automation tokens.
		tokenId:
			authContext.tokenType === "ai" ? (authContext.aiTokenId ?? null) : null,
	};
};

const permissionMessages: Record<TestPermission, string> = {
	"test_case.view": "Your role cannot view test cases in this organisation",
	"test_case.create": "Your role cannot create test cases in this organisation",
	"test_case.update": "Your role cannot edit test cases in this organisation",
	"test_case.approve":
		"Your role cannot approve test cases in this organisation",
	"test_case.delete": "Your role cannot delete test cases in this organisation",
	"test_run.create": "Your role cannot run test cases in this organisation",
	"test_run.cancel": "Your role cannot cancel test runs in this organisation",
	"test_run.cancel_any": "Your role cannot cancel other people's test runs",
	"test_run.view": "Your role cannot view test runs in this organisation",
	"test_config.manage":
		"Your role cannot manage test configuration in this organisation",
	"test_config.use":
		"Your role cannot use test configuration in this organisation",
};

export const requireTestPermission = async (
	db: BackendDb,
	actor: TestActor,
	...permissions: TestPermission[]
): Promise<void> => {
	const granted = await testCasePolicy.permissions(db, {
		organizationId: actor.orgId,
		userId: actor.userId,
	});
	const missing = permissions.find((permission) => !granted.has(permission));
	if (missing) {
		throw new HttpError(
			403,
			"TEST_PERMISSION_DENIED",
			permissionMessages[missing],
			{ permission: missing },
		);
	}
};

export const requireAnyTestPermission = async (
	db: BackendDb,
	actor: TestActor,
	...permissions: TestPermission[]
): Promise<void> => {
	const granted = await testCasePolicy.permissions(db, {
		organizationId: actor.orgId,
		userId: actor.userId,
	});
	if (!permissions.some((permission) => granted.has(permission))) {
		const first = permissions[0] ?? "test_case.view";
		throw new HttpError(
			403,
			"TEST_PERMISSION_DENIED",
			permissionMessages[first],
			{ permission: first },
		);
	}
};
