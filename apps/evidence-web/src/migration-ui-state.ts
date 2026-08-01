import type { MigrationStatus } from "@jittle-lamp/shared";

export type MigrationActions = {
	canPause: boolean;
	canResume: boolean;
	canSync: boolean;
	canRetry: boolean;
	canFinalize: boolean;
	canAbortFinalization: boolean;
	canBreak: boolean;
};

export const migrationPollingInterval = (
	status: MigrationStatus | null | undefined,
): number | false => {
	const runStatus = status?.run?.status;
	if (["queued", "running", "waiting_peer", "pause_requested"].includes(runStatus ?? "")) {
		return 2_000;
	}
	if (["paused", "failed"].includes(runStatus ?? "")) return 15_000;
	return false;
};

export const migrationActions = (
	status: MigrationStatus | null | undefined,
): MigrationActions => {
	const run = status?.run;
	const link = status?.link;
	const active = ["queued", "running", "waiting_peer", "pause_requested"].includes(
		run?.status ?? "",
	);
	const finalRecoverable =
		run?.kind === "final" &&
		status?.accessState === "finalizing_read_only" &&
		["paused", "failed"].includes(run.status);
	return {
		canPause: Boolean(run && ["queued", "running", "waiting_peer"].includes(run.status)),
		canResume: run?.status === "paused",
		canSync: Boolean(link?.state === "synced" && !active),
		canRetry: run?.status === "failed",
		canFinalize: Boolean(link?.state === "synced" && !active),
		canAbortFinalization: finalRecoverable,
		canBreak: link?.state === "completed",
	};
};

export const migrationProgressPercent = (
	completed: number,
	total: number,
): number => (total <= 0 ? 0 : Math.min(100, Math.round((completed / total) * 100)));
