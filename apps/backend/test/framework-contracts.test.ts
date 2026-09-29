import { describe, expect, it } from "bun:test";
import { t } from "elysia";

import { createApp } from "../src/app";
import { createTestEnv } from "./test-utils";

describe("framework HTTP contracts", () => {
	it("keeps the API error envelope and request ID for missing routes", async () => {
		const { app } = createApp(createTestEnv({ LOG_LEVEL: "silent" }));
		const response = await app.handle(
			new Request("http://localhost/missing", {
				headers: { "x-request-id": "missing-route" },
			}),
		);

		expect(response.status).toBe(404);
		expect(response.headers.get("x-request-id")).toBe("missing-route");
		expect(await response.json()).toMatchObject({
			error: { code: "NOT_FOUND", status: 404, requestId: "missing-route" },
		});
	});

	it("validates request bodies before calling the route handler", async () => {
		const { app } = createApp(createTestEnv({ LOG_LEVEL: "silent" }));
		let calls = 0;
		app.post(
			"/schema-contract",
			{ body: t.Object({ name: t.String({ minLength: 1 }) }) },
			({ body }) => {
				calls += 1;
				return { name: body.name };
			},
		);
		const send = (body: unknown) =>
			app.handle(
				new Request("http://localhost/schema-contract", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			);

		const invalid = await send({ name: 42 });
		expect(invalid.status).toBe(422);
		expect(await invalid.json()).toMatchObject({
			error: { code: "VALIDATION", status: 422 },
		});
		expect(calls).toBe(0);

		const valid = await send({ name: "Ready" });
		expect(valid.status).toBe(200);
		expect(await valid.json()).toEqual({ name: "Ready" });
		expect(calls).toBe(1);
	});

	it("hides unexpected server errors from clients", async () => {
		const { app } = createApp(createTestEnv({ LOG_LEVEL: "silent" }));
		app.get("/error-contract", () => {
			throw new Error("Private database connection detail");
		});
		const response = await app.handle(
			new Request("http://localhost/error-contract"),
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			error: {
				code: "UNKNOWN",
				message: "Internal server error",
				status: 500,
			},
		});
	});

	it("serves credential-free CORS preflight only for allowed origins", async () => {
		const { app } = createApp(createTestEnv({ LOG_LEVEL: "silent" }));
		const preflight = (origin: string) =>
			app.handle(
				new Request("http://localhost/protected/me", {
					method: "OPTIONS",
					headers: {
						origin,
						"access-control-request-method": "GET",
						"access-control-request-headers": "authorization",
					},
				}),
			);

		const allowed = await preflight("http://127.0.0.1:4173");
		expect(allowed.status).toBe(204);
		expect(allowed.headers.get("access-control-allow-origin")).toBe(
			"http://127.0.0.1:4173",
		);
		expect(allowed.headers.get("access-control-allow-credentials")).toBeNull();
		const denied = await preflight("https://untrusted.example");
		expect(denied.headers.get("access-control-allow-origin")).toBeNull();
	});
});
