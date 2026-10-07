import { describe, expect, it } from "bun:test";
import type { ImportBatch, TestCaseDetail } from "@jittle-lamp/shared";
import {
	AI_ACCESS_TOKEN_SCOPE,
	AI_MCP_TOKEN_SCOPE,
	createAiAccessToken,
} from "../src/services/ai-access-tokens";
import { createTestCaseFixture, loginTranscript } from "./test-case-fixtures";

describe("agent authoring requires a human review", () => {
	for (const tokenKind of ["ai", "automation"] as const) {
		it(`${tokenKind}: create, edit, approve, run and duplicate obey the review gate`, async () => {
			const f = await createTestCaseFixture();
			const token =
				tokenKind === "automation"
					? await f.automationToken(f.admin)
					: (
							await createAiAccessToken(f.db, {
								userId: f.admin.userId,
								label: "agent",
								expiresAt: null,
								scopes: [AI_ACCESS_TOKEN_SCOPE, AI_MCP_TOKEN_SCOPE],
							})
						).token;
			const created = await f.call<TestCaseDetail>("/test-cases", {
				token,
				body: {
					transcript: loginTranscript(),
					source: "manual",
					status: "active",
				},
			});
			expect(created.status).toBe(201);
			expect(created.body).toMatchObject({ status: "review", source: "ai" });
			const id = created.body.id;
			expect(
				(await f.call(`/test-cases/${id}/runs`, { token, body: {} })).status,
			).toBe(409);
			for (const status of ["active", "draft", "archived"]) {
				expect(
					(
						await f.call(`/test-cases/${id}`, {
							method: "PATCH",
							token,
							body: { status },
						})
					).status,
				).toBe(403);
			}
			expect(
				(await f.call(`/test-cases/${id}/approve`, { token, body: {} })).status,
			).toBe(403);
			expect(
				(
					await f.call(`/test-cases/${id}/approve`, {
						token: f.admin.token,
						body: {},
					})
				).status,
			).toBe(200);
			if (tokenKind === "ai") {
				const duplicate = await f.call<{ testCase: TestCaseDetail }>(
					`/test-cases/${id}/duplicate`,
					{ token, body: {} },
				);
				expect(duplicate.status).toBe(201);
				expect(duplicate.body.testCase.status).toBe("review");
			}
			const unchanged = await f.call<TestCaseDetail>(`/test-cases/${id}`, {
				method: "PATCH",
				token,
				body: { transcript: loginTranscript() },
			});
			expect(unchanged.body.status).toBe("active");
			const updated = await f.call<TestCaseDetail>(`/test-cases/${id}`, {
				method: "PATCH",
				token,
				body: {
					transcript: loginTranscript("Agent revision"),
					expectedVersion: created.body.transcriptVersion,
				},
			});
			expect(updated.status).toBe(200);
			expect(updated.body.status).toBe("review");
			expect(
				(
					await f.call(`/test-cases/${id}`, {
						method: "PATCH",
						token,
						body: {
							transcript: loginTranscript("Stale edit"),
							expectedVersion: created.body.transcriptVersion,
						},
					})
				).status,
			).toBe(409);
			const imported = await f.call<ImportBatch>("/test-cases/import", {
				token,
				body: {
					sourceKind: "transcript-doc",
					content: loginTranscript("Imported"),
				},
			});
			expect(imported.status).toBe(201);
			const submitted = await f.call<ImportBatch>(
				`/test-cases/import/${imported.body.id}`,
				{
					method: "PATCH",
					token,
					body: {
						commit: true,
						decisions: [
							{ itemId: imported.body.items[0]?.id, decision: "create" },
						],
					},
				},
			);
			expect(submitted.status).toBe(200);
			const importedCaseId = submitted.body.items[0]?.resultTestCaseId;
			if (!importedCaseId) throw new Error("Expected submitted case");
			const importedCase = await f.call<TestCaseDetail>(
				`/test-cases/${importedCaseId}`,
				{ token },
			);
			expect(importedCase.body.status).toBe("review");
			await f.call(`/test-cases/${id}/approve`, {
				token: f.admin.token,
				body: {},
			});
			const updateImport = await f.call<ImportBatch>("/test-cases/import", {
				token,
				body: {
					sourceKind: "transcript-doc",
					content: loginTranscript("Import revision").replace(
						"\n",
						`\nKey: ${created.body.key}\n`,
					),
				},
			});
			const updateSubmit = await f.call<ImportBatch>(
				`/test-cases/import/${updateImport.body.id}`,
				{ method: "PATCH", token, body: { commit: true } },
			);
			expect(updateSubmit.body.counts.updated).toBe(1);
			expect(
				(await f.call<TestCaseDetail>(`/test-cases/${id}`, { token })).body
					.status,
			).toBe("review");
		});
	}
});
