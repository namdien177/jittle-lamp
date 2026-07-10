import { describe, expect, it } from "bun:test";

import { createTaskQueue } from "../src/services/task-queue";

describe("task queue", () => {
	it("handles concurrent work without exceeding its limit", async () => {
		const queue = createTaskQueue(2);
		let activeTasks = 0;
		let maximumActiveTasks = 0;

		const results = await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				queue.run(async () => {
					activeTasks += 1;
					maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
					await Bun.sleep(5);
					activeTasks -= 1;
					return index;
				}),
			),
		);

		expect(results).toEqual([0, 1, 2, 3, 4, 5]);
		expect(maximumActiveTasks).toBe(2);
	});

	it("continues queued work after a task fails", async () => {
		const queue = createTaskQueue(1);
		const failed = queue.run(async () => {
			throw new Error("conversion failed");
		});
		const completed = queue.run(async () => "completed");

		await expect(failed).rejects.toThrow("conversion failed");
		await expect(completed).resolves.toBe("completed");
	});
});
