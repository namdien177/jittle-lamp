// Fixed-window request counter kept in this process (one backend instance, like the live hub).
// Used for unauthenticated endpoints such as POST /hooks/:endpointId.
export const createWindowLimiter = (input: {
	limit: number;
	windowMs: number;
	maxKeys?: number;
}) => {
	const windows = new Map<string, { start: number; count: number }>();
	const maxKeys = input.maxKeys ?? 10_000;
	return {
		// true when the request may proceed.
		take(key: string, now = Date.now()): boolean {
			let entry = windows.get(key);
			if (!entry || now - entry.start >= input.windowMs) {
				if (!entry && windows.size >= maxKeys) {
					for (const [other, value] of windows) {
						if (now - value.start >= input.windowMs) windows.delete(other);
					}
					// Still full of live windows: refuse rather than grow without bound.
					if (windows.size >= maxKeys) return false;
				}
				entry = { start: now, count: 0 };
				windows.set(key, entry);
			}
			entry.count += 1;
			return entry.count <= input.limit;
		},
	};
};

export type WindowLimiter = ReturnType<typeof createWindowLimiter>;

// Reads a request body up to `maxBytes`, whatever Content-Length says; null when it is larger.
export const readBodyCapped = async (
	request: Request,
	maxBytes: number,
): Promise<Uint8Array | null> => {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
};
