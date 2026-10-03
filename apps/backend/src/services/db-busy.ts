// SQLITE_BUSY handling shared by the run queue and the run request throttle.

export const isBusyError = (error: unknown): boolean => {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current; depth += 1) {
		const text = String(
			(current as { code?: unknown }).code ?? (current as Error).message ?? "",
		);
		if (/SQLITE_BUSY|database is locked/i.test(text)) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
};

// Concurrent writers on separate connections can see SQLITE_BUSY; the statement is atomic, so
// retrying it is safe.
export const withBusyRetry = async <T>(
	operation: () => Promise<T>,
	attempts = 20,
): Promise<T> => {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if (!isBusyError(error) || attempt >= attempts) throw error;
			await new Promise((resolve) =>
				setTimeout(resolve, 5 + Math.random() * 20 * attempt),
			);
		}
	}
};
