import { describe, expect, it } from "bun:test";
import type { TestCredential } from "@jittle-lamp/shared";
import { createClient } from "@libsql/client";
import { createTestCaseFixture, FAKE_PASSWORD } from "./test-case-fixtures";

describe("credential login field persistence", () => {
	it("keeps the selected field through PATCH, rotation, list and env-file export", async () => {
		const fixture = await createTestCaseFixture();
		const env = await fixture.call<{ id: string }>("/test-environments", {
			token: fixture.admin.token,
			body: { name: "nickname-uat", baseUrl: "https://fixture.example.test" },
		});
		const created = await fixture.call<TestCredential>("/test-credentials", {
			token: fixture.admin.token,
			body: {
				profile: "NICKNAME_ADMIN",
				environmentId: env.body.id,
				fields: { nickname: "qa-nick", email: "qa@example.test" },
				loginField: "nickname",
				secretFields: { password: FAKE_PASSWORD },
			},
		});
		expect(created.status).toBe(201);
		expect(created.body.loginField).toBe("nickname");
		const client = createClient({ url: fixture.databaseUrl });
		expect(
			(
				await client.execute(
					"select login_field from test_credentials where profile = 'NICKNAME_ADMIN'",
				)
			).rows[0]?.login_field,
		).toBe("nickname");
		client.close();
		const patched = await fixture.call<TestCredential>(
			`/test-credentials/${created.body.id}`,
			{
				method: "PATCH",
				token: fixture.admin.token,
				body: { secretFields: { password: "fixture-replacement" } },
			},
		);
		expect(patched.status).toBe(200);
		expect(patched.body.loginField).toBe("nickname");
		const rotated = await fixture.call<TestCredential>(
			`/test-credentials/${created.body.id}/rotate`,
			{
				token: fixture.admin.token,
				body: { secretFields: { password: "fixture-rotated" } },
			},
		);
		expect(rotated.status).toBe(200);
		expect(rotated.body.loginField).toBe("nickname");
		const listed = await fixture.call<{ items: TestCredential[] }>(
			"/test-credentials",
			{ token: fixture.admin.token },
		);
		expect(listed.body.items[0]?.loginField).toBe("nickname");
		expect(JSON.stringify(listed.body)).not.toContain("fixture-rotated");
		const pulled = await fixture.call<{ content: string }>(
			`/test-environments/${env.body.id}/env-file`,
			{ token: fixture.admin.token },
		);
		expect(pulled.body.content).toContain(
			'JL_CREDENTIAL_NICKNAME_ADMIN_LOGIN_FIELD="nickname"',
		);
		expect(pulled.body.content).toContain(
			'JL_CREDENTIAL_NICKNAME_ADMIN_PUBLIC_FIELDS="email,nickname"',
		);
		expect(pulled.body.content).toContain(
			'JL_CREDENTIAL_NICKNAME_ADMIN_SECRET_FIELDS="password"',
		);
		expect(pulled.body.content).not.toContain("fixture-rotated");
		const automatic = await fixture.call<TestCredential>(
			`/test-credentials/${created.body.id}`,
			{
				method: "PATCH",
				token: fixture.admin.token,
				body: { fields: { employee_code: "E123" }, loginField: null },
			},
		);
		expect(automatic.status).toBe(200);
		expect(automatic.body.loginField).toBeNull();
	});

	it("allows secret rotation for a legacy ambiguous profile without changing its public fields", async () => {
		const fixture = await createTestCaseFixture();
		const created = await fixture.call<TestCredential>("/test-credentials", {
			token: fixture.admin.token,
			body: {
				profile: "LEGACY",
				fields: { email: "qa@example.test" },
				secretFields: { password: FAKE_PASSWORD },
			},
		});
		const client = createClient({ url: fixture.databaseUrl });
		await client.execute({
			sql: "update test_credentials set fields_json = ? where id = ?",
			args: [
				JSON.stringify({ email: "qa@example.test", nickname: "qa-nick" }),
				created.body.id,
			],
		});
		client.close();
		const rotated = await fixture.call<TestCredential>(
			`/test-credentials/${created.body.id}/rotate`,
			{
				token: fixture.admin.token,
				body: { secretFields: { password: "fixture-rotated" } },
			},
		);
		expect(rotated.status).toBe(200);
		expect(rotated.body.loginField).toBeNull();
		expect(rotated.body.fields).toEqual({
			email: "qa@example.test",
			nickname: "qa-nick",
		});
		const changed = await fixture.call(`/test-credentials/${created.body.id}`, {
			method: "PATCH",
			token: fixture.admin.token,
			body: { fields: { email: "new@example.test", nickname: "qa-nick" } },
		});
		expect(changed.status).toBe(422);
	});

	it("rejects ambiguous, absent, empty and secret selections before changing stored credentials", async () => {
		const fixture = await createTestCaseFixture();
		for (const body of [
			{ fields: { nickname: "nick", email: "email" } },
			{ fields: { nickname: "nick" }, loginField: "missing" },
			{ fields: { nickname: "" }, loginField: "nickname" },
			{
				fields: { nickname: "nick" },
				loginField: "password",
				secretFields: { password: FAKE_PASSWORD },
			},
		]) {
			const response = await fixture.call("/test-credentials", {
				token: fixture.admin.token,
				body: { profile: "INVALID", ...body },
			});
			expect(response.status).toBe(422);
			expect(response.body).toMatchObject({
				error: { code: "CREDENTIAL_LOGIN_FIELD_INVALID" },
			});
		}
		const created = await fixture.call<TestCredential>("/test-credentials", {
			token: fixture.admin.token,
			body: {
				profile: "VALID",
				fields: { email: "qa@example.test" },
				secretFields: { password: FAKE_PASSWORD },
			},
		});
		expect(created.status).toBe(201);
		const conflict = await fixture.call(
			`/test-credentials/${created.body.id}`,
			{
				method: "PATCH",
				token: fixture.admin.token,
				body: {
					fields: { email: "qa@example.test", password: "public-value" },
					loginField: "password",
				},
			},
		);
		expect(conflict.status).toBe(422);
		expect(conflict.body).toMatchObject({
			error: { code: "CREDENTIAL_FIELD_OVERLAP" },
		});
		const listed = await fixture.call<{ items: TestCredential[] }>(
			"/test-credentials",
			{ token: fixture.admin.token },
		);
		expect(listed.body.items).toHaveLength(1);
		expect(listed.body.items[0]?.fields).toEqual({ email: "qa@example.test" });
	});
});
