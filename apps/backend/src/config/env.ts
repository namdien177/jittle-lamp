import { z } from "zod/v4";

export const nodeEnvSchema = z.enum([
	"local",
	"development",
	"staging",
	"production",
]);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

const optionalNonEmptyString = z.preprocess(
	(value) => (value === "" ? undefined : value),
	z.string().min(1).optional(),
);

const optionalUrlString = z.preprocess(
	(value) => (value === "" ? undefined : value),
	z.string().url().optional(),
);

const isBase64Key = (value: string): boolean =>
	/^[A-Za-z0-9+/]+={0,2}$/.test(value.trim()) &&
	Buffer.from(value.trim(), "base64").byteLength === 32;

const envSchema = z
	.object({
		NODE_ENV: nodeEnvSchema.default("local"),
		PORT: z.coerce.number().int().min(1).max(65535).default(3001),
		HOST: z.string().default("0.0.0.0"),
		APP_VERSION: z.string().default("0.1.3"),
		APP_SECRET: optionalNonEmptyString.pipe(z.string().min(24).optional()),
		DATABASE_URL: optionalUrlString,
		RUN_DB_MIGRATIONS: z.string().optional(),
		TURSO_AUTH_TOKEN: optionalNonEmptyString,
		S3_BUCKET: optionalNonEmptyString,
		S3_KEY_PREFIX: optionalNonEmptyString.pipe(
			z
				.string()
				.regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/)
				.optional(),
		),
		S3_REGION: optionalNonEmptyString,
		S3_ENDPOINT: optionalUrlString,
		S3_ACCESS_KEY_ID: optionalNonEmptyString,
		S3_SECRET_ACCESS_KEY: optionalNonEmptyString,
		S3_FORCE_PATH_STYLE: z.string().optional(),
		S3_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(60).optional(),
		VIDEO_NORMALIZATION_CONCURRENCY: z.coerce
			.number()
			.int()
			.min(1)
			.max(8)
			.default(2),
		MIGRATION_WORKER_CONCURRENCY: z.coerce
			.number()
			.int()
			.min(1)
			.max(4)
			.default(1),
		LOG_LEVEL: z
			.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
			.optional(),
		CLERK_PUBLISHABLE_KEY: optionalNonEmptyString,
		CLERK_SECRET_KEY: optionalNonEmptyString,
		CLERK_JWT_KEY: optionalNonEmptyString,
		CLERK_AUDIENCE: optionalNonEmptyString,
		CLERK_AUTHORIZED_PARTIES: optionalNonEmptyString,
		VERCEL_PREVIEW_PROJECT: optionalNonEmptyString.pipe(
			z
				.string()
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
				.optional(),
		),
		VERCEL_PREVIEW_TEAM: optionalNonEmptyString.pipe(
			z
				.string()
				.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
				.optional(),
		),
		WEB_APP_ORIGIN: optionalUrlString,
		JITTLE_LAMP_API_ORIGIN: optionalUrlString,
		JITTLE_LAMP_DEV_AUTH_ENABLED: z.string().optional(),
		// Base64 of 32 random bytes; wraps the per-organisation data keys of test credential
		// secrets. Optional at startup: only credential reads and writes need it.
		JL_SECRETS_MASTER_KEY: optionalNonEmptyString,
		// The previous master key while data keys are re-wrapped after a master key rotation.
		JL_SECRETS_MASTER_KEY_PREVIOUS: optionalNonEmptyString,
	})
	.superRefine((env, ctx) => {
		for (const key of [
			"JL_SECRETS_MASTER_KEY",
			"JL_SECRETS_MASTER_KEY_PREVIOUS",
		] as const) {
			const value = env[key];
			if (value !== undefined && !isBase64Key(value)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: [key],
					message: `${key} must be base64 of exactly 32 bytes (generate with: openssl rand -base64 32)`,
				});
			}
		}

		if (env.NODE_ENV === "production" && !env.APP_SECRET) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["APP_SECRET"],
				message: "APP_SECRET is required in production",
			});
		}

		if (env.DATABASE_URL?.startsWith("libsql://") && !env.TURSO_AUTH_TOKEN) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["TURSO_AUTH_TOKEN"],
				message: "TURSO_AUTH_TOKEN is required for remote libSQL/Turso URLs",
			});
		}

		const s3Configured = Boolean(
			env.S3_BUCKET ||
				env.S3_REGION ||
				env.S3_ENDPOINT ||
				env.S3_ACCESS_KEY_ID ||
				env.S3_SECRET_ACCESS_KEY,
		);
		if (s3Configured) {
			for (const key of [
				"S3_BUCKET",
				"S3_REGION",
				"S3_ACCESS_KEY_ID",
				"S3_SECRET_ACCESS_KEY",
			] as const) {
				if (!env[key]) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: [key],
						message: `${key} is required when S3 storage is configured`,
					});
				}
			}
		}

		if (env.NODE_ENV === "production" && !env.S3_BUCKET) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["S3_BUCKET"],
				message: "S3_BUCKET is required in production",
			});
		}

		if (env.VERCEL_PREVIEW_PROJECT || env.VERCEL_PREVIEW_TEAM) {
			if (
				env.NODE_ENV !== "staging" ||
				!env.CLERK_PUBLISHABLE_KEY?.startsWith("pk_test_") ||
				(env.CLERK_SECRET_KEY !== undefined &&
					!env.CLERK_SECRET_KEY.startsWith("sk_test_")) ||
				!env.VERCEL_PREVIEW_PROJECT ||
				!env.VERCEL_PREVIEW_TEAM
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["VERCEL_PREVIEW_PROJECT"],
					message:
						"Vercel preview origins require staging, a Clerk test instance, and both VERCEL_PREVIEW_PROJECT and VERCEL_PREVIEW_TEAM",
				});
			}
		}

		const clerkConfigured = Boolean(
			env.CLERK_PUBLISHABLE_KEY || env.CLERK_SECRET_KEY || env.CLERK_JWT_KEY,
		);
		if (!clerkConfigured) {
			return;
		}

		if (!env.CLERK_SECRET_KEY && !env.CLERK_JWT_KEY) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["CLERK_SECRET_KEY"],
				message:
					"CLERK_SECRET_KEY or CLERK_JWT_KEY is required when Clerk auth is configured",
			});
		}

		if (env.NODE_ENV === "staging" || env.NODE_ENV === "production") {
			if (!env.CLERK_PUBLISHABLE_KEY) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["CLERK_PUBLISHABLE_KEY"],
					message:
						"CLERK_PUBLISHABLE_KEY is required in staging/production when Clerk auth is enabled",
				});
			}

			if (!env.CLERK_AUTHORIZED_PARTIES) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["CLERK_AUTHORIZED_PARTIES"],
					message:
						"CLERK_AUTHORIZED_PARTIES is required in staging/production when Clerk auth is enabled",
				});
			}
		}
	});

export type AppEnv = z.infer<typeof envSchema>;

export const parseEnv = (source: Record<string, string | undefined>): AppEnv =>
	envSchema.parse(source);
