import { createApp } from "./app";
import { cleanupExpiredDeviceAuthState } from "./services/desktop-auth";
import {
	cleanupAbandonedEvidenceUploads,
	purgeExpiredDeletedEvidences,
} from "./services/evidence-maintenance";
import { cleanupExpiredOrganizationActivityLogs } from "./services/organization-activity";
import { cleanupExpiredGuestMemberships } from "./services/organization-management";
import { runDatabaseMigrations } from "./startup/run-database-migrations";

const { app, runtime, logger, db, artifactStorage } = createApp(process.env);

if (
	(runtime.nodeEnv === "production" || runtime.nodeEnv === "staging") &&
	!runtime.apiOrigin
) {
	// Without a configured public API origin, proxy-forwarded host headers are
	// no longer trusted, so generated upload URLs fall back to the connection
	// origin — which is usually the internal host behind the proxy and will
	// break extension/desktop uploads. Surface this loudly at boot.
	logger.warn(
		"JITTLE_LAMP_API_ORIGIN is not set; upload URLs will use the connection origin and may be unreachable by clients behind a proxy",
	);
}

try {
	await runDatabaseMigrations({ db, runtime, logger });
	if (db) {
		const runMaintenance = async () => {
			try {
				const removed = await cleanupExpiredGuestMemberships(db);
				if (removed > 0) {
					logger.info(
						{ removed },
						"expired guest organization memberships cleaned up",
					);
				}
			} catch (err) {
				logger.error(
					{ err },
					"failed to clean up expired guest organization memberships",
				);
			}

			try {
				const removed = await cleanupAbandonedEvidenceUploads(
					db,
					artifactStorage,
				);
				if (removed > 0) {
					logger.info({ removed }, "abandoned evidence uploads cleaned up");
				}
			} catch (err) {
				logger.error({ err }, "failed to clean up abandoned evidence uploads");
			}

			try {
				const removed = await purgeExpiredDeletedEvidences(db, artifactStorage);
				if (removed > 0) {
					logger.info({ removed }, "expired deleted evidences purged");
				}
			} catch (err) {
				logger.error({ err }, "failed to purge expired deleted evidences");
			}

			try {
				const removed = await cleanupExpiredDeviceAuthState(db);
				if (removed > 0) {
					logger.info({ removed }, "expired device sessions cleaned up");
				}
			} catch (err) {
				logger.error({ err }, "failed to clean up expired device sessions");
			}

			try {
				const removed = await cleanupExpiredOrganizationActivityLogs(db);
				if (removed > 0) {
					logger.info(
						{ removed },
						"expired organization activity logs cleaned up",
					);
				}
			} catch (err) {
				logger.error(
					{ err },
					"failed to clean up expired organization activity logs",
				);
			}
		};
		setInterval(() => void runMaintenance(), 60 * 60 * 1000).unref();
		void runMaintenance();
	}
	app.listen({ hostname: runtime.host, port: runtime.port }, () => {
		logger.info(
			{ host: runtime.host, port: runtime.port, env: runtime.nodeEnv },
			"backend listening",
		);
	});
} catch (error) {
	logger.error(
		{ err: error, databaseUrlConfigured: Boolean(runtime.databaseUrl) },
		"failed to apply database migrations",
	);
	process.exit(1);
}
