import type { AppEnv, NodeEnv } from "./env";

const defaultsByEnv: Record<
	NodeEnv,
	{ logLevel: AppEnv["LOG_LEVEL"]; enableOpenApi: boolean }
> = {
	local: { logLevel: "debug", enableOpenApi: true },
	development: { logLevel: "debug", enableOpenApi: true },
	staging: { logLevel: "info", enableOpenApi: false },
	production: { logLevel: "info", enableOpenApi: false },
};

export type RuntimeConfig = {
	host: string;
	port: number;
	version: string;
	nodeEnv: NodeEnv;
	secret: string | undefined;
	databaseUrl: string | undefined;
	runDbMigrations: boolean;
	tursoAuthToken: string | undefined;
	videoNormalizationConcurrency: number;
	s3:
		| {
				bucket: string;
				region: string;
				endpoint: string | undefined;
				accessKeyId: string;
				secretAccessKey: string;
				forcePathStyle: boolean;
				signedUrlTtlSeconds: number;
		  }
		| undefined;
	logLevel: Exclude<NonNullable<AppEnv["LOG_LEVEL"]>, "silent">;
	enableOpenApi: boolean;
	clerkPublishableKey: string | undefined;
	clerkSecretKey: string | undefined;
	clerkJwtKey: string | undefined;
	clerkAudience: string | undefined;
	clerkAuthorizedParties: string[] | undefined;
	webAppOrigin: string | undefined;
	apiOrigin: string | undefined;
};

const normalizeOrigin = (origin: string) => origin.replace(/\/+$/, "");

const normalizePem = (value: string | undefined): string | undefined =>
	value?.replace(/\\n/g, "\n");

const parseAuthorizedParties = (
	authorizedParties: string | undefined,
): string[] | undefined => {
	if (!authorizedParties) {
		return undefined;
	}

	const parsed = authorizedParties
		.split(",")
		.map((value) => value.trim())
		.map((value) => value.replace(/\/+$/, ""))
		.filter(Boolean);

	return parsed.length > 0 ? parsed : undefined;
};

const parseBooleanFlag = (
	value: string | undefined,
	defaultValue = false,
): boolean => {
	if (value === undefined) {
		return defaultValue;
	}

	switch (value.trim().toLowerCase()) {
		case "1":
		case "true":
		case "yes":
		case "on":
			return true;
		case "0":
		case "false":
		case "no":
		case "off":
			return false;
		default:
			return defaultValue;
	}
};

export const buildRuntimeConfig = (env: AppEnv): RuntimeConfig => {
	const defaults = defaultsByEnv[env.NODE_ENV];
	const resolvedLogLevel = env.LOG_LEVEL ?? defaults.logLevel ?? "info";

	return {
		host: env.HOST,
		port: env.PORT,
		version: env.APP_VERSION,
		nodeEnv: env.NODE_ENV,
		secret: env.APP_SECRET,
		databaseUrl: env.DATABASE_URL,
		runDbMigrations: parseBooleanFlag(env.RUN_DB_MIGRATIONS, false),
		tursoAuthToken: env.TURSO_AUTH_TOKEN,
		videoNormalizationConcurrency: env.VIDEO_NORMALIZATION_CONCURRENCY,
		s3:
			env.S3_BUCKET &&
			env.S3_REGION &&
			env.S3_ACCESS_KEY_ID &&
			env.S3_SECRET_ACCESS_KEY
				? {
						bucket: env.S3_BUCKET,
						region: env.S3_REGION,
						endpoint: env.S3_ENDPOINT,
						accessKeyId: env.S3_ACCESS_KEY_ID,
						secretAccessKey: env.S3_SECRET_ACCESS_KEY,
						forcePathStyle: parseBooleanFlag(env.S3_FORCE_PATH_STYLE, false),
						signedUrlTtlSeconds: env.S3_SIGNED_URL_TTL_SECONDS ?? 900,
					}
				: undefined,
		logLevel: resolvedLogLevel === "silent" ? "info" : resolvedLogLevel,
		enableOpenApi: defaults.enableOpenApi,
		clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY,
		clerkSecretKey: env.CLERK_SECRET_KEY,
		clerkJwtKey: normalizePem(env.CLERK_JWT_KEY),
		clerkAudience: env.CLERK_AUDIENCE,
		clerkAuthorizedParties: parseAuthorizedParties(
			env.CLERK_AUTHORIZED_PARTIES,
		),
		webAppOrigin: env.WEB_APP_ORIGIN,
		apiOrigin: env.JITTLE_LAMP_API_ORIGIN
			? normalizeOrigin(env.JITTLE_LAMP_API_ORIGIN)
			: undefined,
	};
};
