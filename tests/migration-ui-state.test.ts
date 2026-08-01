import { describe, expect, it } from "bun:test";
import type { MigrationRunStatus, MigrationStatus } from "@jittle-lamp/shared";
import {
	migrationActions,
	migrationPollingInterval,
	migrationProgressPercent,
} from "../apps/evidence-web/src/migration-ui-state";

const status = (overrides: {
	runStatus?: MigrationRunStatus;
	runKind?: "full" | "delta" | "final";
	linkState?: NonNullable<MigrationStatus["link"]>["state"];
}): MigrationStatus => ({
	link: {
		id: crypto.randomUUID(),
		direction: "outbound",
		localOrganizationId: crypto.randomUUID(),
		remoteOrganizationId: crypto.randomUUID(),
		remoteInstanceId: crypto.randomUUID(),
		remoteApiOrigin: "https://api.example.test",
		remoteWebOrigin: "https://example.test",
		protocolVersion: "1.0",
		state: overrides.linkState ?? "synced",
		lastSuccessfulAt: Date.now(),
		createdAt: Date.now(),
		updatedAt: Date.now(),
	},
	run: overrides.runStatus
		? ({
				id: crypto.randomUUID(),
				linkId: crypto.randomUUID(),
				organizationId: crypto.randomUUID(),
				kind: overrides.runKind ?? "delta",
				status: overrides.runStatus,
				stage: "records",
				override: false,
				progress: {
					identities: { completed: 1, total: 1 },
					records: { completed: 2, total: 4 },
					artifacts: { completed: 0, total: 1 },
					bytes: { transferred: 0, total: 10 },
					warnings: [],
				},
				errorCode: null,
				errorMessage: null,
				attempts: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				completedAt: null,
			}) as NonNullable<MigrationStatus["run"]>
		: null,
	accessState:
		overrides.runKind === "final" ? "finalizing_read_only" : "writable",
	destinationWebOrigin: "https://example.test",
	verificationReceipt: null,
});

describe("migration UI state", () => {
	it("polls active work quickly and recoverable work slowly", () => {
		expect(migrationPollingInterval(status({ runStatus: "running" }))).toBe(2_000);
		expect(migrationPollingInterval(status({ runStatus: "failed" }))).toBe(15_000);
		expect(migrationPollingInterval(status({ runStatus: "succeeded" }))).toBeFalse();
	});

	it("exposes finalization recovery and completed-link actions", () => {
		expect(
			migrationActions(status({ runStatus: "failed", runKind: "final" }))
				.canAbortFinalization,
		).toBeTrue();
		expect(migrationActions(status({ linkState: "completed" })).canBreak).toBeTrue();
	});

	it("calculates bounded progress", () => {
		expect(migrationProgressPercent(2, 4)).toBe(50);
		expect(migrationProgressPercent(20, 4)).toBe(100);
		expect(migrationProgressPercent(0, 0)).toBe(0);
	});
});
