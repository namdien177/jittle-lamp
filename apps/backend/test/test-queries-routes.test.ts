import { describe, expect, it } from "bun:test";
import type {
	ClaimedRun,
	CreateTestRunResponse,
	TestCaseDetail,
	TestCredential,
	TestQuery,
	TestRunConfig,
} from "@jittle-lamp/shared";
import { createClient } from "@libsql/client";

import { createTestCaseFixture, FAKE_PASSWORD } from "./test-case-fixtures";
import { registerRunner } from "./test-run-fixtures";

// Saved queries per postgres profile (roadmap 2026-10-13 §5.2 tier 3), the shared SQL guard at
// save time, the per-step SQL script cache and the run config carrying the profile's queries.

const seed = async () => {
	const fixture = await createTestCaseFixture();
	const environment = await fixture.call<{ id: string }>("/test-environments", {
		token: fixture.admin.token,
		body: {
			name: "pcf-uat",
			baseUrl: "https://uat.example.test",
			runnerPool: "self-hosted:devbox",
		},
	});
	if (environment.status !== 201)
		throw new Error(JSON.stringify(environment.body));
	const database = await fixture.call<TestCredential>("/test-credentials", {
		token: fixture.admin.token,
		body: {
			profile: "PCF_UAT_DB",
			kind: "postgres",
			environmentId: environment.body.id,
			fields: {
				host: "db.internal.test",
				port: "5432",
				database: "sv",
				user: "readonly",
				ssl: "require",
				schema_allowlist: "public, reporting",
			},
			secretFields: { password: FAKE_PASSWORD },
		},
	});
	if (database.status !== 201) throw new Error(JSON.stringify(database.body));
	const login = await fixture.call<TestCredential>("/test-credentials", {
		token: fixture.admin.token,
		body: {
			profile: "PCF_HQ_ADMIN",
			fields: { username: "hq.admin@example.test" },
			secretFields: { password: FAKE_PASSWORD },
		},
	});
	if (login.status !== 201) throw new Error(JSON.stringify(login.body));
	return {
		fixture,
		environmentId: environment.body.id,
		database: database.body,
		login: login.body,
	};
};

describe("saved query routes", () => {
	it("saves, lists, edits and deletes guarded queries per postgres profile", async () => {
		const { fixture, database, login } = await seed();
		const created = await fixture.call<TestQuery>("/test-queries", {
			token: fixture.admin.token,
			body: {
				credentialId: database.id,
				name: "k1-pending",
				sqlText:
					"select id, name from students where level = $1 and status = 'PENDING'",
				params: [{ name: "level" }],
			},
		});
		expect(created.status).toBe(201);
		expect(created.body).toMatchObject({
			profile: "PCF_UAT_DB",
			name: "k1-pending",
			params: [{ name: "level", kind: "text" }],
		});

		// Reads need test_config.use; writes need test_config.manage.
		const listedByQa = await fixture.call<{ items: TestQuery[] }>(
			"/test-queries",
			{ token: fixture.qa.token },
		);
		expect(listedByQa.status).toBe(200);
		expect(listedByQa.body.items.map((item) => item.name)).toEqual([
			"k1-pending",
		]);
		const forbidden = await fixture.call("/test-queries", {
			token: fixture.qa.token,
			body: {
				credentialId: database.id,
				name: "nope",
				sqlText: "select 1 from students",
			},
		});
		expect(forbidden.status).toBe(403);

		const filtered = await fixture.call<{ items: TestQuery[] }>(
			`/test-queries?credentialId=${login.id}`,
			{ token: fixture.admin.token },
		);
		expect(filtered.body.items).toEqual([]);

		const duplicate = await fixture.call<{ error: { code: string } }>(
			"/test-queries",
			{
				token: fixture.admin.token,
				body: {
					credentialId: database.id,
					name: "K1-Pending",
					sqlText: "select 1 from students",
				},
			},
		);
		expect(duplicate.status).toBe(409);

		const patched = await fixture.call<TestQuery>(
			`/test-queries/${created.body.id}`,
			{
				method: "PATCH",
				token: fixture.admin.token,
				body: { sqlText: "select id from students where level = $1 limit 5" },
			},
		);
		expect(patched.status).toBe(200);
		expect(patched.body.sqlText).toBe(
			"select id from students where level = $1 limit 5",
		);
		expect(patched.body.params).toEqual([{ name: "level", kind: "text" }]);

		const deleted = await fixture.call(`/test-queries/${created.body.id}`, {
			method: "DELETE",
			token: fixture.admin.token,
		});
		expect(deleted.status).toBe(200);
		const after = await fixture.call<{ items: TestQuery[] }>("/test-queries", {
			token: fixture.admin.token,
		});
		expect(after.body.items).toEqual([]);
		// The name is free again once the query is gone.
		const again = await fixture.call<TestQuery>("/test-queries", {
			token: fixture.admin.token,
			body: {
				credentialId: database.id,
				name: "k1-pending",
				sqlText: "select 1 from students",
			},
		});
		expect(again.status).toBe(201);
	});

	it("refuses statements the shared guard rejects and mismatched params", async () => {
		const { fixture, database, login } = await seed();
		const reject = async (body: Record<string, unknown>) =>
			fixture.call<{
				error: { code: string; message: string; errors?: string[] };
			}>("/test-queries", {
				token: fixture.admin.token,
				body: { credentialId: database.id, ...body },
			});
		const dml = await reject({ name: "wipe", sqlText: "delete from students" });
		expect(dml.status).toBe(422);
		expect(dml.body.error.code).toBe("TEST_QUERY_REJECTED");
		expect(dml.body.error.message).toContain('"delete" is not allowed');
		const schema = await reject({
			name: "users",
			sqlText: "select * from auth.users",
		});
		expect(schema.status).toBe(422);
		expect(schema.body.error.message).toContain('Schema "auth"');
		const multi = await reject({
			name: "two",
			sqlText: "select 1 from students; select 2 from students",
		});
		expect(multi.status).toBe(422);
		const params = await reject({
			name: "params",
			sqlText: "select 1 from students where id = $1 and name = $2",
			params: [{ name: "id" }],
		});
		expect(params.status).toBe(422);
		expect(params.body.error.code).toBe("TEST_QUERY_PARAMS_MISMATCH");
		const reporting = await fixture.call<TestQuery>("/test-queries", {
			token: fixture.admin.token,
			body: {
				credentialId: database.id,
				name: "daily",
				sqlText: "select * from reporting.daily_counts",
			},
		});
		expect(reporting.status).toBe(201);
		// A login profile cannot own a query.
		const onLogin = await fixture.call<{ error: { code: string } }>(
			"/test-queries",
			{
				token: fixture.admin.token,
				body: {
					credentialId: login.id,
					name: "x",
					sqlText: "select 1 from students",
				},
			},
		);
		expect(onLogin.status).toBe(404);
	});

	it("ships the profile's queries in the run config and caches SQL scripts per step", async () => {
		const { fixture, database, environmentId } = await seed();
		await fixture.call("/test-queries", {
			token: fixture.admin.token,
			body: {
				credentialId: database.id,
				name: "k1-pending",
				sqlText: "select id, name from students where level = $1",
				params: [{ name: "level" }],
			},
		});
		const transcript = [
			"# K1 student detail",
			"",
			"[Query: PCF_UAT_DB, name=k1-pending] a K1 student -> {student}",
			"[Open] /students/{student.id}",
			"",
			"## Checkpoint: The detail page opens",
			"[Assert] the page shows {student.name}",
		].join("\n");
		const created = await fixture.call<TestCaseDetail>("/test-cases", {
			token: fixture.qa.token,
			body: { transcript, environmentId },
		});
		expect(created.status).toBe(201);
		expect(created.body.lintErrors).toBe(0);
		const requested = await fixture.call<CreateTestRunResponse>(
			`/test-cases/${created.body.id}/runs`,
			{ token: fixture.qa.token, body: {} },
		);
		expect(requested.status).toBe(201);
		const runner = await registerRunner(fixture);
		const claim = await fixture.call<{ run: ClaimedRun | null }>(
			"/runner-pools/claim",
			{ token: runner.workerToken, body: {} },
		);
		const claimed = claim.body.run;
		if (!claimed) throw new Error("Expected a claimed run");

		const config = await fixture.call<TestRunConfig>(
			`/test-runs/${claimed.runId}/config`,
			{ token: claimed.runToken },
		);
		expect(config.status).toBe(200);
		expect(config.body.credentials).toEqual([
			{
				profile: "PCF_UAT_DB",
				kind: "postgres",
				fields: {
					host: "db.internal.test",
					port: "5432",
					database: "sv",
					user: "readonly",
					ssl: "require",
					schema_allowlist: "public, reporting",
				},
				loginField: null,
				secretFields: { password: FAKE_PASSWORD },
			},
		]);
		expect(config.body.queries).toEqual([
			{
				profile: "PCF_UAT_DB",
				name: "k1-pending",
				sqlText: "select id, name from students where level = $1",
				params: [{ name: "level", kind: "text" }],
			},
		]);

		// The SQL script cache: PUT, GET hit, DELETE marks stale, GET miss.
		const stepId = created.body.steps[0]?.stepId ?? "step";
		const miss = await fixture.call<{ status: string }>(
			`/test-runs/${claimed.runId}/cache/sql/${stepId}`,
			{ token: claimed.runToken },
		);
		expect(miss.body).toEqual({ status: "miss" });
		const put = await fixture.call(
			`/test-runs/${claimed.runId}/cache/sql/${stepId}`,
			{
				method: "PUT",
				token: claimed.runToken,
				body: {
					sqlText: "select id, name from students where level = $1 LIMIT 50",
					params: ["level"],
					binding: "student",
					instructionKey: "sha256:abc",
				},
			},
		);
		expect(put.status).toBe(200);
		const hit = await fixture.call<{ status: string; script: unknown }>(
			`/test-runs/${claimed.runId}/cache/sql/${stepId}`,
			{ token: claimed.runToken },
		);
		expect(hit.body).toEqual({
			status: "hit",
			script: {
				sqlText: "select id, name from students where level = $1 LIMIT 50",
				params: ["level"],
				binding: "student",
				instructionKey: "sha256:abc",
			},
		});
		const client = createClient({ url: fixture.databaseUrl });
		const rows = (
			await client.execute(
				"select kind, key_hash, sql_text, status from test_step_scripts",
			)
		).rows;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "sql",
			key_hash: `sql:${stepId}`,
			sql_text: "select id, name from students where level = $1 LIMIT 50",
			status: "active",
		});
		const stale = await fixture.call(
			`/test-runs/${claimed.runId}/cache/sql/${stepId}`,
			{
				method: "DELETE",
				token: claimed.runToken,
				body: { reason: "replay returned no rows" },
			},
		);
		expect(stale.status).toBe(200);
		const afterStale = (
			await client.execute("select status, stale_reason from test_step_scripts")
		).rows[0];
		expect(afterStale?.status).toBe("stale");
		expect(String(afterStale?.stale_reason)).toContain(
			"replay returned no rows",
		);
		client.close();
		const missAgain = await fixture.call<{ status: string }>(
			`/test-runs/${claimed.runId}/cache/sql/${stepId}`,
			{ token: claimed.runToken },
		);
		expect(missAgain.body).toEqual({ status: "miss" });
		// A stranger's token reads nothing.
		const stranger = await fixture.call(
			`/test-runs/${claimed.runId}/cache/sql/${stepId}`,
			{ token: fixture.qa.token },
		);
		expect(stranger.status).toBeGreaterThanOrEqual(401);
		// Nothing in the config or the scripts leaks beyond the postgres profile the case names.
		expect(JSON.stringify(config.body)).not.toContain("PCF_HQ_ADMIN");
	});
});
