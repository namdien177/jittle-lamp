import { describe, expect, it } from "bun:test";
import type { TestCaseDetail, TestCaseListResponse } from "@jittle-lamp/shared";

import { normalizeQuery } from "../src/http/test-http";
import { createTestCaseFixture } from "./test-case-fixtures";

const url = (query: string) => `http://api.test/test-cases?${query}`;

describe("normalizeQuery", () => {
	it("keeps free text as strings even when it reads as a boolean or a number", () => {
		expect(
			normalizeQuery(url("q=true&title=2024&transcript=false&cursor=123")),
		).toEqual({ q: "true", title: "2024", transcript: "false", cursor: "123" });
	});

	it("coerces only the known numeric and boolean keys", () => {
		expect(
			normalizeQuery(
				url("limit=25&noRunsSinceDays=30&staleCache=true&unreadOnly=false"),
			),
		).toEqual({
			limit: 25,
			noRunsSinceDays: 30,
			staleCache: true,
			unreadOnly: false,
		});
		expect(normalizeQuery(url("limit=lots&staleCache=yes"))).toEqual({
			limit: "lots",
			staleCache: "yes",
		});
	});

	it("still splits array keys", () => {
		expect(normalizeQuery(url("status=review,active&tags=a"))).toEqual({
			status: ["review", "active"],
			tags: ["a"],
		});
	});
});

describe("search routes with boolean- or number-like text", () => {
	it("answers list search and similar lookups for q=true and numeric titles", async () => {
		const fixture = await createTestCaseFixture();
		const created = await fixture.call<TestCaseDetail>("/test-cases", {
			token: fixture.qa.token,
			body: {
				transcript:
					"# 2024 true\n\n[Open] /login\n[Act] sign in\n\n## Checkpoint: Signed in\n[Assert] the dashboard is visible",
			},
		});
		expect(created.status).toBe(201);

		for (const q of ["true", "false", "2024"]) {
			const list = await fixture.call<TestCaseListResponse>(
				`/test-cases?q=${q}`,
				{ token: fixture.qa.token },
			);
			expect(list.status).toBe(200);
		}
		const similar = await fixture.call<{ items: Array<{ id: string }> }>(
			"/test-cases/similar?q=2024&title=2024",
			{ token: fixture.qa.token },
		);
		expect(similar.status).toBe(200);
		const titleTrue = await fixture.call<{ items: Array<{ id: string }> }>(
			"/test-cases/similar?title=true",
			{ token: fixture.qa.token },
		);
		expect(titleTrue.status).toBe(200);
	});
});
