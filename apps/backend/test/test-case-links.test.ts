import { describe, expect, it } from "bun:test";
import type { TestCaseDetail } from "@jittle-lamp/shared";
import { eq } from "drizzle-orm";

import { testCases } from "../src/db/schema";
import { parseLinksColumn } from "../src/services/test-cases";
import { createTestCaseFixture, loginTranscript } from "./test-case-fixtures";

// Review finding: links became http(s)-only, and a stored case holding one older non-http link
// came back with no links at all because the whole array failed validation.

describe("stored test case links", () => {
	it("drops only the non-http entries of a stored links column", () => {
		expect(
			parseLinksColumn(
				JSON.stringify([
					{ url: "https://jira.example.test/browse/PCF-1", label: null },
					{ url: "javascript:alert(1)", label: null },
					{ url: "file:///etc/passwd", label: "local" },
					"not an object",
					{ url: "http://wiki.example.test/page", label: "spec" },
				]),
			),
		).toEqual([
			{ url: "https://jira.example.test/browse/PCF-1", label: null },
			{ url: "http://wiki.example.test/page", label: "spec" },
		]);
		expect(parseLinksColumn("not json")).toEqual([]);
		expect(parseLinksColumn(JSON.stringify({ url: "https://x.test" }))).toEqual(
			[],
		);
		expect(parseLinksColumn(null)).toEqual([]);
	});

	it("returns the valid links of a case that also stores a non-http link", async () => {
		const fixture = await createTestCaseFixture();
		const created = await fixture.call<TestCaseDetail>("/test-cases", {
			token: fixture.qa.token,
			body: { transcript: loginTranscript() },
		});
		expect(created.status).toBe(201);
		await fixture.db
			.update(testCases)
			.set({
				linksJson: JSON.stringify([
					{ url: "https://jira.example.test/browse/PCF-1", label: null },
					{ url: "javascript:alert(1)", label: null },
				]),
			})
			.where(eq(testCases.id, created.body.id));
		const detail = await fixture.call<TestCaseDetail>(
			`/test-cases/${created.body.id}`,
			{ token: fixture.qa.token },
		);
		expect(detail.status).toBe(200);
		expect(detail.body.links).toEqual([
			{ url: "https://jira.example.test/browse/PCF-1", label: null },
		]);
	});
});
