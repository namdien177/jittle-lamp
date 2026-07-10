export type TaskQueue = {
	run: <T>(task: () => Promise<T>) => Promise<T>;
};

export const createTaskQueue = (maximumConcurrency: number): TaskQueue => {
	let activeTasks = 0;
	const waitingTasks: Array<() => void> = [];

	const acquire = async (): Promise<void> => {
		if (activeTasks < maximumConcurrency && waitingTasks.length === 0) {
			activeTasks += 1;
			return;
		}

		await new Promise<void>((resolve) => {
			waitingTasks.push(() => {
				activeTasks += 1;
				resolve();
			});
		});
	};

	return {
		run: async <T>(task: () => Promise<T>): Promise<T> => {
			await acquire();
			try {
				return await task();
			} finally {
				activeTasks -= 1;
				waitingTasks.shift()?.();
			}
		},
	};
};
