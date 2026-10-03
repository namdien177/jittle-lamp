import { openapi } from "@elysia/openapi";
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
import { createDevArtifactRoutes } from "./routes/dev-artifacts";
import { createEvidenceUploadRoutes } from "./routes/evidence-uploads";
import { createEvidenceRoutes } from "./routes/evidences";
import { createExtensionAuthRoutes } from "./routes/extension-auth";
import { createHealthRoutes } from "./routes/health";
import {
	createMigrationDiscoveryRoutes,
	createMigrationManagementRoutes,
} from "./routes/migrations";
import { createNotificationRoutes } from "./routes/notifications";
import { createOrganizationRoutes } from "./routes/orgs";
import { createProtectedRoutes } from "./routes/protected";
import { createRunnerPoolRoutes } from "./routes/runner-pools";
import { createShareLinkRoutes } from "./routes/share-links";
import { createTestCaseRoutes } from "./routes/test-cases";
import { createTestConfigRoutes } from "./routes/test-config";
import { createTestLiveRoutes } from "./routes/test-live";
import { createTestRunRoutes } from "./routes/test-runs";
import { createTestWebhookRoutes } from "./routes/test-webhooks";
import {
	type ArtifactStorage,
	createArtifactStorage,
	devArtifactReadEnabled,
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
import { createEnvKeyProvider, type KeyProvider } from "./services/test-config";
import type { TextGenerator } from "./services/test-imports";
import { createLiveHub, type LiveHub } from "./services/test-live";
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
		keyProvider?: KeyProvider;
		generateText?: TextGenerator;
		fetch?: typeof fetch;
		liveHub?: LiveHub;
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

	const keyProvider =
		dependencies.keyProvider ??
		createEnvKeyProvider({
			masterKey: runtime.secretsMasterKey,
			previousMasterKey: runtime.secretsMasterKeyPrevious,
		});

	// Live view state of running runs (one backend instance; see services/test-live.ts).
	const liveHub = dependencies.liveHub ?? createLiveHub();

	const core = createCorePlugin({
		runtime,
		db,
		logger,
		artifactStorage,
		videoNormalizationQueue,
		videoNormalizer,
		keyProvider,
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
									"Jittle Lamp account AI token for evidence debugging or MCP actions, according to its scopes",
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
		.use(
			createTestCaseRoutes(auth, {
				...(dependencies.generateText
					? { generateText: dependencies.generateText }
					: {}),
				...(dependencies.fetch ? { fetchImpl: dependencies.fetch } : {}),
			}),
		)
		.use(createTestRunRoutes(auth, liveHub))
		.use(createTestLiveRoutes(auth, liveHub))
		.use(
			createTestWebhookRoutes(
				auth,
				dependencies.fetch ? { fetchImpl: dependencies.fetch } : {},
			),
		)
		.use(createTestConfigRoutes(auth))
		.use(createRunnerPoolRoutes(auth))
		.use(createNotificationRoutes(auth))
		.use(createProtectedRoutes(auth));

	if (artifactStorage.mode === "memory" && devArtifactReadEnabled(runtime)) {
		logger.warn(
			"DEV ONLY: serving in-memory artifacts through signed /dev/artifacts URLs",
		);
		app.use(createDevArtifactRoutes(core));
	}

	return {
		app,
		runtime,
		logger,
		db,
		artifactStorage,
		organizationMigration,
		keyProvider,
		liveHub,
	};
};

export type App = ReturnType<typeof createApp>["app"];
