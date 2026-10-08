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
import { createOrganizationStorageRoutes } from "./routes/org-storage";
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
import {
	createSlackChannelAdapter,
	createWebhookChannelAdapter,
} from "./services/notification-channels";
import { registerNotificationAdapter } from "./services/notifications";
import { createOrganizationMigration } from "./services/organization-migration";
import { createOrganizationStorageService } from "./services/organization-storage";
import { outboundPolicyFromEnv } from "./services/outbound-http";
import {
	createStorageRegistry,
	type StorageClientFactory,
} from "./services/storage-registry";
import { createStorageTransfers } from "./services/storage-transfer";
import { createTaskQueue } from "./services/task-queue";
import {
	createEnvKeyProvider,
	createTestSecrets,
	type KeyProvider,
} from "./services/test-config";
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
		// Builds clients for organisation-owned buckets; tests inject in-memory fakes.
		storageClientFactory?: StorageClientFactory;
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

	const storageRegistry = createStorageRegistry({
		db,
		defaultStorage: artifactStorage,
		secrets: db ? createTestSecrets({ db, keyProvider }) : null,
		...(runtime.s3
			? { signedUrlTtlSeconds: runtime.s3.signedUrlTtlSeconds }
			: {}),
		...(dependencies.storageClientFactory
			? { clientFactory: dependencies.storageClientFactory }
			: {}),
	});

	// Live view state of running runs (one backend instance; see services/test-live.ts).
	const liveHub = dependencies.liveHub ?? createLiveHub();

	const core = createCorePlugin({
		runtime,
		db,
		logger,
		artifactStorage,
		storageRegistry,
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
				storageRegistry,
				peerClient: migrationPeerClient,
				clerkDirectory,
				directoryConfigured: Boolean(dependencies.clerkDirectory),
			})
		: null;

	// SSRF guard for addresses organisations configure (services/outbound-http.ts).
	const outbound = outboundPolicyFromEnv({
		nodeEnv: runtime.nodeEnv,
		allowLoopbackFlag: source.JL_OUTBOUND_ALLOW_LOOPBACK,
		allowHosts: source.JL_OUTBOUND_ALLOW_HOSTS,
	});

	// Organisation storage statistics, bring-your-own buckets and transfers.
	const organizationStorage = db
		? (() => {
				const storage = createOrganizationStorageService({
					db,
					runtime,
					registry: storageRegistry,
					secrets: createTestSecrets({ db, keyProvider }),
					outbound,
				});
				return {
					storage,
					transfers: createStorageTransfers({
						db,
						registry: storageRegistry,
						storage,
					}),
				};
			})()
		: null;

	// Slack and outgoing-webhook channels on the notification bus (design.md §10b).
	if (db) {
		const channelDeps = {
			secrets: createTestSecrets({ db, keyProvider }),
			fetch: dependencies.fetch ?? fetch,
			outbound,
			webOrigin: runtime.webAppOrigin ?? null,
		};
		registerNotificationAdapter(createSlackChannelAdapter(channelDeps), db);
		registerNotificationAdapter(createWebhookChannelAdapter(channelDeps), db);
	}

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
		.use(createOrganizationStorageRoutes(auth, organizationStorage))
		.use(createMigrationManagementRoutes(auth, organizationMigration))
		.use(
			createTestCaseRoutes(auth, {
				...(dependencies.generateText
					? { generateText: dependencies.generateText }
					: {}),
				...(dependencies.fetch ? { fetchImpl: dependencies.fetch } : {}),
				outbound,
			}),
		)
		.use(createTestRunRoutes(auth, liveHub))
		.use(createTestLiveRoutes(auth, liveHub))
		.use(
			createTestWebhookRoutes(auth, {
				outbound,
				...(dependencies.fetch ? { fetchImpl: dependencies.fetch } : {}),
			}),
		)
		.use(createTestConfigRoutes(auth, { outbound }))
		.use(
			createRunnerPoolRoutes(auth, {
				...(dependencies.generateText
					? { generateText: dependencies.generateText }
					: {}),
				outbound,
			}),
		)
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
		storageRegistry,
		organizationStorage,
		organizationMigration,
		keyProvider,
		liveHub,
		outbound,
	};
};

export type App = ReturnType<typeof createApp>["app"];
