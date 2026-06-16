import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";

import { parseEnv } from "./config/env";
import { buildRuntimeConfig } from "./config/runtime";
import { createDb } from "./db";
import { createClerkAuthPlugin } from "./plugins/clerk-auth";
import { createCorePlugin } from "./plugins/core";
import { createAiRoutes } from "./routes/ai";
import { createClerkRoutes } from "./routes/clerk";
import { createDesktopAuthRoutes } from "./routes/desktop-auth";
import { createEvidenceUploadRoutes } from "./routes/evidence-uploads";
import { createEvidenceRoutes } from "./routes/evidences";
import { createExtensionAuthRoutes } from "./routes/extension-auth";
import { createHealthRoutes } from "./routes/health";
import { createOrganizationRoutes } from "./routes/orgs";
import { createProtectedRoutes } from "./routes/protected";
import { createShareLinkRoutes } from "./routes/share-links";
import { createArtifactStorage } from "./services/artifact-storage";
import { createLogger } from "./utils/logger";

export const createApp = (
	source: Record<string, string | undefined> = process.env,
) => {
	const env = parseEnv(source);
	const runtime = buildRuntimeConfig(env);
	const logger = createLogger(runtime.logLevel);
	const db = createDb(runtime.databaseUrl, runtime.tursoAuthToken);
	const artifactStorage = createArtifactStorage(runtime);

	const core = createCorePlugin({ runtime, db, logger, artifactStorage });
	const auth = createClerkAuthPlugin(core);

	const app = new Elysia().use(core);

	if (runtime.enableOpenApi) {
		app.use(
			openapi({
				path: "/docs",
				specPath: "/docs/json",
				documentation: {
					info: {
						title: "Jittle Lamp Backend API",
						version: runtime.version,
					},
					components: {
						securitySchemes: {
							clerkSession: {
								type: "http",
								scheme: "bearer",
								bearerFormat: "JWT",
								description:
									"Clerk session token provided by Authorization header or session cookie",
							},
							aiAccessToken: {
								type: "http",
								scheme: "bearer",
								description:
									"Jittle Lamp AI access token issued per account for read-only evidence debugging",
							},
						},
					},
				},
			}),
		);
	}

	app
		.use(createHealthRoutes(core))
		.use(createAiRoutes(auth))
		.use(createClerkRoutes(auth))
		.use(createDesktopAuthRoutes(auth))
		.use(createExtensionAuthRoutes(auth))
		.use(createEvidenceUploadRoutes(auth))
		.use(createEvidenceRoutes(auth))
		.use(createShareLinkRoutes(auth))
		.use(createOrganizationRoutes(auth))
		.use(createProtectedRoutes(auth));

	return { app, runtime, logger, db, artifactStorage };
};

export type App = ReturnType<typeof createApp>["app"];
