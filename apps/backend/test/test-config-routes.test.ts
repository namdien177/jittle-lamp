import { describe, expect, it } from "bun:test";
import type {
	ModelCostReport,
	ModelSettings,
	TestCredential,
	TestEnvironment,
	TestMacro,
	TestTag,
} from "@jittle-lamp/shared";
import { createClient } from "@libsql/client";
import { and, eq } from "drizzle-orm";

import { organizationActivityLogs } from "../src/db/schema";
import {
	createTestCaseFixture,
	FAKE_MODEL_KEY,
	FAKE_PASSWORD,
	loginTranscript,
} from "./test-case-fixtures";

describe("test configuration routes", () => {
	it("manages environments and credentials with write-only secrets", async () => {
		const fixture = await createTestCaseFixture();
		const env = await fixture.call<TestEnvironment>("/test-environments", {
			token: fixture.admin.token,
			body: {
				name: "pcf-uat",
				baseUrl: "https://uat.example.test",
				variables: { PARENT_URL: "https://parent.example.test" },
				runnerPool: "self-hosted:devbox",
				agentInstructions: "Never delete records.",
			},
		});
		expect(env.status).toBe(201);
		expect(env.body).toMatchObject({ name: "pcf-uat", usedByCases: 0 });
		const duplicate = await fixture.call("/test-environments", {
			token: fixture.admin.token,
			body: { name: "pcf-uat", baseUrl: "https://other.example.test" },
		});
		expect(duplicate.status).toBe(409);
		const qaDenied = await fixture.call("/test-environments", {
			token: fixture.qa.token,
			body: { name: "qa-env", baseUrl: "https://qa.example.test" },
		});
		expect(qaDenied.status).toBe(403);
		const patched = await fixture.call<TestEnvironment>(
			`/test-environments/${env.body.id}`,
			{
				method: "PATCH",
				token: fixture.admin.token,
				body: { notes: "shared UAT" },
			},
		);
		expect(patched.body).toMatchObject({
			notes: "shared UAT",
			baseUrl: "https://uat.example.test",
			variables: { PARENT_URL: "https://parent.example.test" },
		});

		const created = await fixture.call<TestCredential>("/test-credentials", {
			token: fixture.admin.token,
			body: {
				profile: "PCF_HQ_ADMIN",
				environmentId: env.body.id,
				fields: { username: "hq.admin@example.test" },
				secretFields: { password: FAKE_PASSWORD, otp_seed: "fake-otp-seed" },
			},
		});
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({
			profile: "PCF_HQ_ADMIN",
			kind: "login",
			secretFieldNames: ["otp_seed", "password"],
			keyVersion: 1,
		});
		expect(JSON.stringify(created.body)).not.toContain(FAKE_PASSWORD);

		// Omitted secret fields keep their value; null removes one.
		const updated = await fixture.call<TestCredential>(
			`/test-credentials/${created.body.id}`,
			{
				method: "PATCH",
				token: fixture.admin.token,
				body: { secretFields: { otp_seed: null } },
			},
		);
		expect(updated.body.secretFieldNames).toEqual(["password"]);
		expect(updated.body.fields).toEqual({ username: "hq.admin@example.test" });
		const rotated = await fixture.call<TestCredential>(
			`/test-credentials/${created.body.id}/rotate`,
			{
				token: fixture.admin.token,
				body: { secretFields: { password: "fake-rotated-Passw0rd" } },
			},
		);
		expect(rotated.status).toBe(200);
		expect(rotated.body.secretFieldNames).toEqual(["password"]);

		const listed = await fixture.call<{ items: TestCredential[] }>(
			"/test-credentials",
			{ token: fixture.developer.token },
		);
		expect(listed.body.items.map((item) => item.profile)).toEqual([
			"PCF_HQ_ADMIN",
		]);
		expect(JSON.stringify(listed.body)).not.toContain("fake-rotated");

		const client = createClient({ url: fixture.databaseUrl });
		const rows = await client.execute("select * from test_credentials");
		expect(JSON.stringify(rows.rows)).not.toContain("fake-rotated-Passw0rd");
		expect(JSON.stringify(rows.rows)).not.toContain(FAKE_PASSWORD);
		client.close();

		// env pull: placeholders without secrets, values only for test_config.manage.
		const plain = await fixture.call<{ content: string }>(
			`/test-environments/${env.body.id}/env-file`,
			{ token: fixture.developer.token },
		);
		expect(plain.body.content).toContain('JL_ENV_NAME="pcf-uat"');
		expect(plain.body.content).toContain(
			'JL_VAR_PARENT_URL="https://parent.example.test"',
		);
		expect(plain.body.content).toContain(
			'JL_CRED_PCF_HQ_ADMIN_USERNAME="hq.admin@example.test"',
		);
		expect(plain.body.content).toContain('JL_CRED_PCF_HQ_ADMIN_PASSWORD=""');
		const deniedSecrets = await fixture.call(
			`/test-environments/${env.body.id}/env-file?withSecrets=true`,
			{ token: fixture.qa.token },
		);
		expect(deniedSecrets.status).toBe(403);
		const withSecrets = await fixture.call<{ content: string }>(
			`/test-environments/${env.body.id}/env-file?withSecrets=true`,
			{ token: fixture.admin.token },
		);
		expect(withSecrets.body.content).toContain(
			'JL_CRED_PCF_HQ_ADMIN_PASSWORD="fake-rotated-Passw0rd"',
		);
		const reads = await fixture.db.query.organizationActivityLogs.findMany({
			where: and(
				eq(organizationActivityLogs.organizationId, fixture.orgId),
				eq(organizationActivityLogs.action, "test_config.secret_read"),
			),
		});
		expect(
			reads.some(
				(log) => JSON.parse(log.metadataJson).reason === "env-file.pull",
			),
		).toBe(true);

		const removed = await fixture.call(`/test-credentials/${created.body.id}`, {
			method: "DELETE",
			token: fixture.admin.token,
		});
		expect(removed.status).toBe(200);
		expect(
			(
				await fixture.call<{ items: unknown[] }>("/test-credentials", {
					token: fixture.admin.token,
				})
			).body.items,
		).toHaveLength(0);
	});

	it("stores the BYOK model key encrypted and reports model cost", async () => {
		const fixture = await createTestCaseFixture();
		const defaults = await fixture.call<ModelSettings>("/test-model-settings", {
			token: fixture.qa.token,
		});
		expect(defaults.body).toEqual({
			actModel: "anthropic/claude-opus-5-5",
			judgeModel: "anthropic/claude-sonnet-5-5",
			provider: "anthropic",
			keyConfigured: false,
			keyLast4: null,
		});
		const saved = await fixture.call<ModelSettings>("/test-model-settings", {
			method: "PUT",
			token: fixture.admin.token,
			body: {
				actModel: "openrouter/anthropic/claude-opus-5.5",
				judgeModel: "openrouter/anthropic/claude-sonnet-5.5",
				apiKey: FAKE_MODEL_KEY,
			},
		});
		expect(saved.body).toEqual({
			actModel: "openrouter/anthropic/claude-opus-5.5",
			judgeModel: "openrouter/anthropic/claude-sonnet-5.5",
			provider: "openrouter",
			keyConfigured: true,
			keyLast4: "0000",
		});
		expect(JSON.stringify(saved.body)).not.toContain(FAKE_MODEL_KEY);
		// The key credential is internal and does not show up as a profile.
		expect(
			(
				await fixture.call<{ items: unknown[] }>("/test-credentials", {
					token: fixture.admin.token,
				})
			).body.items,
		).toHaveLength(0);
		const cleared = await fixture.call<ModelSettings>("/test-model-settings", {
			method: "PUT",
			token: fixture.admin.token,
			body: {
				actModel: "anthropic/claude-opus-5-5",
				judgeModel: "anthropic/claude-sonnet-5-5",
				apiKey: null,
			},
		});
		expect(cleared.body.keyConfigured).toBe(false);

		const report = await fixture.call<ModelCostReport>("/test-model-costs", {
			token: fixture.admin.token,
		});
		expect(report.status).toBe(200);
		expect(report.body).toMatchObject({ totalCostUsd: 0, runs: 0, byUser: [] });
	});

	it("manages macros, tags, run settings and agent notes", async () => {
		const fixture = await createTestCaseFixture();
		const macro = await fixture.call<TestMacro>("/test-macros", {
			token: fixture.admin.token,
			body: {
				name: "Login",
				params: [{ name: "profile", required: true, kind: "credential" }],
				transcript:
					"[Open] /login\n[Act] type {cred:{profile}.username} into Email",
			},
		});
		expect(macro.status).toBe(201);
		expect(macro.body).toMatchObject({
			name: "Login",
			version: 1,
			status: "active",
		});
		const edited = await fixture.call<TestMacro>(
			`/test-macros/${macro.body.id}`,
			{
				method: "PATCH",
				token: fixture.admin.token,
				body: { transcript: "[Open] /signin\n[Act] sign in as {profile}" },
			},
		);
		expect(edited.body.version).toBe(2);
		const tag = await fixture.call<TestTag>("/test-tags", {
			token: fixture.admin.token,
			body: { namespace: "team", name: "qa-pcf", color: "#0a84ff" },
		});
		expect(tag.status).toBe(201);
		await fixture.call("/test-cases", {
			token: fixture.qa.token,
			body: { transcript: loginTranscript() },
		});
		const tags = await fixture.call<{ items: TestTag[] }>("/test-tags", {
			token: fixture.developer.token,
		});
		expect(tags.body.items).toEqual([{ ...tag.body, count: 1 }]);

		const settings = await fixture.call<{ maxConcurrentRuns: number }>(
			"/test-run-settings",
			{ token: fixture.qa.token },
		);
		expect(settings.body).toMatchObject({
			maxConcurrentRuns: 1,
			dedupeWindowSeconds: 120,
			maxQueuedRuns: 20,
			maxQueuedPerCase: 3,
			tokenBucketSize: 30,
			tokenBucketWindowSeconds: 600,
			retention: { failedDays: 180, passedDays: 30 },
		});
		const invalid = await fixture.call("/test-run-settings", {
			method: "PUT",
			token: fixture.admin.token,
			body: { maxConcurrentRuns: 0 },
		});
		expect(invalid.status).toBe(422);
		const notes = await fixture.call<{ notes: string }>("/test-agent-notes", {
			method: "PUT",
			token: fixture.admin.token,
			body: { notes: "Use the E2E prefix." },
		});
		expect(notes.body.notes).toBe("Use the E2E prefix.");
	});

	it("fails credential writes clearly without a master key", async () => {
		const fixture = await createTestCaseFixture({
			env: { JL_SECRETS_MASTER_KEY: undefined },
		});
		const response = await fixture.call("/test-credentials", {
			token: fixture.admin.token,
			body: { profile: "PCF", secretFields: { password: FAKE_PASSWORD } },
		});
		expect(response.status).toBe(503);
		expect(response.body).toMatchObject({
			error: { code: "SECRETS_MASTER_KEY_MISSING" },
		});
		expect(JSON.stringify(response.body)).toContain("openssl rand -base64 32");
		// Public-only profiles and every other setting still work.
		const publicOnly = await fixture.call("/test-credentials", {
			token: fixture.admin.token,
			body: { profile: "PUBLIC_ONLY", fields: { username: "u@example.test" } },
		});
		expect(publicOnly.status).toBe(201);
	});
});
