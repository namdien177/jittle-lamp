import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";

import { parseEnv } from "./config/env";
import { buildRuntimeConfig } from "./config/runtime";
import { createDb } from "./db";
import { createClerkAuthPlugin } from "./plugins/clerk-auth";
import { createCorePlugin } from "./plugins/core";
import { createAiRoutes } from "./routes/ai";
import { createAutomationRoutes } from "./routes/automation";
import { createClerkRoutes } from "./routes/clerk";
import { createDesktopAuthRoutes } from "./routes/desktop-auth";
import { createEvidenceUploadRoutes } from "./routes/evidence-uploads";
import { createEvidenceRoutes } from "./routes/evidences";
import { createExtensionAuthRoutes } from "./routes/extension-auth";
import { createHealthRoutes } from "./routes/health";
import {
	createMigrationDiscoveryRoutes,
	createMigrationManagementRoutes,
} from "./routes/migrations";
import { createOrganizationRoutes } from "./routes/orgs";
import { createProtectedRoutes } from "./routes/protected";
import { createShareLinkRoutes } from "./routes/share-links";
import {
	type ArtifactStorage,
	createArtifactStorage,
} from "./services/artifact-storage";
import {
	type ClerkDirectory,
	createClerkDirectory,
} from "./services/clerk-directory";
import {
	createHttpMigrationPeerClient,
	type MigrationPeerClient,
} from "./services/migration-peer-client";
import { createOrganizationMigration } from "./services/organization-migration";
import { createTaskQueue } from "./services/task-queue";
import {
	normalizeVideoTo720p,
	type VideoNormalizer,
} from "./services/video-normalizer";
import { createLogger } from "./utils/logger";

export const createApp = (
	source: Record<string, string | undefined> = process.env,
	dependencies: {
		videoNormalizer?: VideoNormalizer;
		artifactStorage?: ArtifactStorage;
		migrationPeerClient?: MigrationPeerClient;
		clerkDirectory?: ClerkDirectory;
	} = {},
) => {
	const env = parseEnv(source);
	const runtime = buildRuntimeConfig(env);
	const logger = createLogger(runtime.logLevel);
	const db = createDb(runtime.databaseUrl, runtime.tursoAuthToken);
	const artifactStorage =
		dependencies.artifactStorage ?? createArtifactStorage(runtime);
	const videoNormalizationQueue = createTaskQueue(
		runtime.videoNormalizationConcurrency,
	);
	const videoNormalizer = dependencies.videoNormalizer ?? normalizeVideoTo720p;
	const migrationPeerClient =
		dependencies.migrationPeerClient ?? createHttpMigrationPeerClient(runtime);
	const clerkDirectory: ClerkDirectory =
		dependencies.clerkDirectory ??
		(runtime.clerkSecretKey
			? createClerkDirectory(runtime)
			: {
					exportProfile: async () => {
						throw new Error(
							"CLERK_SECRET_KEY is required for organization migration",
						);
					},
					findByVerifiedEmail: async () => [],
					createUser: async () => {
						throw new Error(
							"CLERK_SECRET_KEY is required for organization migration",
						);
					},
				});

	const core = createCorePlugin({
		runtime,
		db,
		logger,
		artifactStorage,
		videoNormalizationQueue,
		videoNormalizer,
	});
	const auth = createClerkAuthPlugin(core);
	const organizationMigration = db
		? createOrganizationMigration({
				db,
				runtime,
				artifactStorage,
				peerClient: migrationPeerClient,
				clerkDirectory,
				directoryConfigured: Boolean(dependencies.clerkDirectory),
			})
		: null;

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
							automationApiToken: {
								type: "http",
								scheme: "bearer",
								description:
									"Jittle Lamp automation API token for uploading evidence ZIPs",
							},
						},
					},
				},
			}),
		);
	}

	app
		.use(createMigrationDiscoveryRoutes(core, organizationMigration))
		.use(createHealthRoutes(core))
		.use(createAiRoutes(auth))
		.use(createAutomationRoutes(auth))
		.use(createClerkRoutes(auth))
		.use(createDesktopAuthRoutes(auth))
		.use(createExtensionAuthRoutes(auth))
		.use(createEvidenceUploadRoutes(auth))
		.use(createEvidenceRoutes(auth))
		.use(createShareLinkRoutes(auth))
		.use(createOrganizationRoutes(auth))
		.use(createMigrationManagementRoutes(auth, organizationMigration))
		.use(createProtectedRoutes(auth));

	return { app, runtime, logger, db, artifactStorage, organizationMigration };
};

export type App = ReturnType<typeof createApp>["app"];
