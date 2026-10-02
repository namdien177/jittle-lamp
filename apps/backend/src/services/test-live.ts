import type { LiveInputEvent, LiveInputRequest } from "@jittle-lamp/shared";

// Live view of a running cloud or self-hosted run (design.md §5.4, ADR 0002 decision 11,
// phase 2 unit 2.3).
//
// Who holds the take-over lives on the run row (test_runs.live_takeover_by), so it survives a
// restart and is visible to every reader. The rest is short-lived and kept in this process:
// who is watching (30 s TTL), the latest JPEG frame (one per run, at most 1 MB) and the queue of
// input events waiting for the runner. This is designed for ONE backend instance. With several
// instances behind a load balancer the runner's frame upload and a viewer's frame read can land
// on different instances; move this hub to a shared store (a small table or Redis) before
// scaling the API horizontally.

export const LIVE_WATCH_TTL_MS = 30_000;
export const LIVE_FRAME_MAX_BYTES = 1024 * 1024;
export const LIVE_INPUT_QUEUE_MAX = 500;
// Entries untouched for this long are dropped (the run finished or the runner went away).
export const LIVE_IDLE_TTL_MS = 10 * 60_000;

export type LiveViewport = { width: number; height: number };

type LiveRunState = {
	watchUntil: number;
	frame: Uint8Array | null;
	frameAt: number | null;
	viewport: LiveViewport | null;
	// Unacknowledged input, in seq order.
	inputs: LiveInputEvent[];
	nextSeq: number;
	touchedAt: number;
};

export class LiveInputQueueFullError extends Error {
	constructor(readonly pending: number) {
		super(`The live input queue is full (${pending} events waiting)`);
		this.name = "LiveInputQueueFullError";
	}
}

// Width and height from the first SOFn segment of a baseline or progressive JPEG.
export const jpegDimensions = (bytes: Uint8Array): LiveViewport | null => {
	if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
		return null;
	}
	let offset = 2;
	while (offset + 9 < bytes.byteLength) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		const marker = bytes[offset + 1] ?? 0;
		if (marker === 0xff) {
			offset += 1;
			continue;
		}
		// Standalone markers carry no length.
		if (
			marker === 0xd8 ||
			marker === 0x01 ||
			(marker >= 0xd0 && marker <= 0xd7)
		) {
			offset += 2;
			continue;
		}
		const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
		const isSof =
			marker >= 0xc0 &&
			marker <= 0xcf &&
			marker !== 0xc4 &&
			marker !== 0xc8 &&
			marker !== 0xcc;
		if (isSof) {
			const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
			const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
			return width > 0 && height > 0 ? { width, height } : null;
		}
		if (length < 2) return null;
		offset += 2 + length;
	}
	return null;
};

export const isJpeg = (bytes: Uint8Array) =>
	bytes.byteLength >= 3 &&
	bytes[0] === 0xff &&
	bytes[1] === 0xd8 &&
	bytes[2] === 0xff;

export const createLiveHub = () => {
	const runs = new Map<string, LiveRunState>();

	const prune = (now: number) => {
		for (const [runId, state] of runs) {
			if (now - state.touchedAt > LIVE_IDLE_TTL_MS) runs.delete(runId);
		}
	};

	const entry = (runId: string, now: number): LiveRunState => {
		let state = runs.get(runId);
		if (!state) {
			if (runs.size > 0 && runs.size % 50 === 0) prune(now);
			state = {
				watchUntil: 0,
				frame: null,
				frameAt: null,
				viewport: null,
				inputs: [],
				nextSeq: 0,
				touchedAt: now,
			};
			runs.set(runId, state);
		}
		state.touchedAt = now;
		return state;
	};

	return {
		watch(runId: string, now = Date.now()): number {
			const state = entry(runId, now);
			state.watchUntil = now + LIVE_WATCH_TTL_MS;
			return state.watchUntil;
		},
		isWatched(runId: string, now = Date.now()): boolean {
			return (runs.get(runId)?.watchUntil ?? 0) > now;
		},
		putFrame(
			runId: string,
			bytes: Uint8Array,
			fallbackViewport: LiveViewport | null,
			now = Date.now(),
		) {
			const state = entry(runId, now);
			state.frame = bytes;
			state.frameAt = now;
			state.viewport = jpegDimensions(bytes) ?? fallbackViewport;
			return { frameAt: now, viewport: state.viewport };
		},
		frame(runId: string): {
			bytes: Uint8Array;
			frameAt: number;
			viewport: LiveViewport | null;
		} | null {
			const state = runs.get(runId);
			if (!state?.frame || state.frameAt === null) return null;
			return {
				bytes: state.frame,
				frameAt: state.frameAt,
				viewport: state.viewport,
			};
		},
		snapshot(runId: string): {
			frameAt: number | null;
			viewport: LiveViewport | null;
			watching: boolean;
		} {
			const state = runs.get(runId);
			return {
				frameAt: state?.frameAt ?? null,
				viewport: state?.viewport ?? null,
				watching: (state?.watchUntil ?? 0) > Date.now(),
			};
		},
		// Assigns increasing sequence numbers; refuses input beyond the queue cap.
		enqueue(
			runId: string,
			events: LiveInputRequest["events"],
			now = Date.now(),
		): LiveInputEvent[] {
			const state = entry(runId, now);
			if (state.inputs.length + events.length > LIVE_INPUT_QUEUE_MAX) {
				throw new LiveInputQueueFullError(state.inputs.length);
			}
			const added = events.map(
				(event) => ({ ...event, seq: state.nextSeq++ }) as LiveInputEvent,
			);
			state.inputs.push(...added);
			return added;
		},
		// The runner acknowledges everything up to `after`; returns what is newer, in seq order.
		pending(runId: string, after: number, now = Date.now()): LiveInputEvent[] {
			const state = entry(runId, now);
			state.inputs = state.inputs.filter((event) => event.seq > after);
			return [...state.inputs];
		},
		clearInputs(runId: string) {
			const state = runs.get(runId);
			if (state) state.inputs = [];
		},
		clear(runId: string) {
			runs.delete(runId);
		},
		size: () => runs.size,
	};
};

export type LiveHub = ReturnType<typeof createLiveHub>;
