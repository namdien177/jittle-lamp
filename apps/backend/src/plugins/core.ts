import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";
import type { Logger } from "pino";

import type { RuntimeConfig } from "../config/runtime";
import { createApiError } from "../http/api-error";
import type { ArtifactStorage } from "../services/artifact-storage";
import type { TaskQueue } from "../services/task-queue";
import type { BackendDb } from "../services/user-provisioning";
import type { VideoNormalizer } from "../services/video-normalizer";

type CorePluginParams = {
	runtime: RuntimeConfig;
	db: BackendDb | null;
	logger: Logger;
	artifactStorage: ArtifactStorage;
	videoNormalizationQueue: TaskQueue;
	videoNormalizer: VideoNormalizer;
};

const getRequestId = (
	request: Request,
	responseHeaderValue?: string | string[],
) => {
	if (
		typeof responseHeaderValue === "string" &&
		responseHeaderValue.length > 0
	) {
		return responseHeaderValue;
	}

	return request.headers.get("x-request-id") ?? crypto.randomUUID();
};

const localWebOrigins = new Set([
	"http://127.0.0.1:4173",
	"http://localhost:4173",
]);

const isDevelopmentRuntime = (runtime: RuntimeConfig) =>
	runtime.nodeEnv === "local" || runtime.nodeEnv === "development";

const normalizeOrigin = (origin: string) => origin.replace(/\/+$/, "");

const errorChainIncludes = (error: unknown, marker: string): boolean => {
	let current: unknown = error;
	const seen = new Set<unknown>();
	while (current && !seen.has(current)) {
		seen.add(current);
		if (String(current).includes(marker)) return true;
		current =
			typeof current === "object" && "cause" in current
				? (current as { cause?: unknown }).cause
				: null;
	}
	return false;
};

const isAllowedCorsOrigin = (runtime: RuntimeConfig, origin: string) => {
	const normalizedOrigin = normalizeOrigin(origin);
	const allowedOrigins = [
		runtime.webAppOrigin,
		...(runtime.clerkAuthorizedParties ?? []),
	]
		.filter((value): value is string => Boolean(value))
		.map(normalizeOrigin);

	if (allowedOrigins.includes(normalizedOrigin)) {
		return true;
	}

	return isDevelopmentRuntime(runtime) && localWebOrigins.has(normalizedOrigin);
};

export const createCorePlugin = ({
	runtime,
	db,
	logger,
	artifactStorage,
	videoNormalizationQueue,
	videoNormalizer,
}: CorePluginParams) =>
	new Elysia({ name: "backend-core" })
		.decorate({
			runtime,
			db,
			logger,
			artifactStorage,
			videoNormalizationQueue,
			videoNormalizer,
		})
		.use(
			// Official CORS plugin handles preflight (204), Vary, and origin
			// reflection. Origins are restricted to the configured web app, Clerk
			// authorized parties, and (in dev) localhost; credentials are off since
			// the API authenticates via bearer tokens, not cookies cross-origin.
			cors({
				origin: (request) => {
					const origin = request.headers.get("origin");
					return origin ? isAllowedCorsOrigin(runtime, origin) : false;
				},
				methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
				allowedHeaders: ["authorization", "content-type", "x-request-id"],
				credentials: false,
				maxAge: 600,
				preflight: true,
			}),
		)
		.onRequest(({ request, set }) => {
			const requestId = getRequestId(request, set.headers["x-request-id"]);
			set.headers["x-request-id"] = requestId;

			logger.child({ requestId }).info(
				{
					method: request.method,
					path: new URL(request.url).pathname,
				},
				"request received",
			);
		})
		.resolve({ as: "global" }, ({ request, set, logger }) => {
			const requestId = getRequestId(request, set.headers["x-request-id"]);

			return {
				requestId,
				requestLogger: logger.child({ requestId }),
			};
		})
		.onError({ as: "global" }, ({ code, error, request, set }) => {
			const requestId = getRequestId(request, set.headers["x-request-id"]);
			const requestLogger = logger.child({ requestId });
			const migrationReadOnly = errorChainIncludes(
				error,
				"ORG_MIGRATION_READ_ONLY",
			);
			const status = migrationReadOnly
				? 423
				: set.status && Number(set.status) >= 400
					? Number(set.status)
					: code === "VALIDATION"
						? 400
						: code === "NOT_FOUND"
							? 404
							: 500;

			requestLogger.error({ err: error, code, status }, "request failed");
			set.status = status;

			// Never leak internal error detail for unexpected server errors; the
			// full error is logged above. Client-facing 4xx messages (e.g.
			// validation) remain informative.
			const message = migrationReadOnly
				? "This organization is read-only during or after migration"
				: status >= 500
					? "Internal server error"
					: error instanceof Error
						? error.message
						: "Unexpected error";

			return createApiError(
				requestId,
				migrationReadOnly ? "ORG_MIGRATION_READ_ONLY" : String(code),
				message,
				status,
			);
		});

export type CorePlugin = ReturnType<typeof createCorePlugin>;
