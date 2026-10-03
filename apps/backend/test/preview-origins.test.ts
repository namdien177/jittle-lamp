import { describe, expect, it } from "bun:test";
import { SignJWT } from "jose";
import { createApp } from "../src/app";
import { parseEnv } from "../src/config/env";
import { isVercelPreviewOrigin } from "../src/config/preview-origins";
import { buildRuntimeConfig } from "../src/config/runtime";
import { createTestEnv, getAuthFixture } from "./test-utils";

const settings = {
	NODE_ENV: "staging",
	CLERK_JWT_KEY: "fixture-public-key",
	LOG_LEVEL: "fatal",
	CLERK_PUBLISHABLE_KEY: "pk_test_cHJldmlldy5leGFtcGxlLnRlc3Qk",
	CLERK_AUTHORIZED_PARTIES: "https://preprod.example.test",
	VERCEL_PREVIEW_PROJECT: "jittler-lamp-desktop",
	VERCEL_PREVIEW_TEAM: "namdien177s-projects",
};
const preview =
	"https://jittler-lamp-desktop-928kf0wfz-namdien177s-projects.vercel.app";

describe("Vercel preview authentication", () => {
	it("accepts a signed session from this project's preview and allows its preflight", async () => {
		const { privateKey, jwtKey } = await getAuthFixture();
		const { app } = createApp(
			createTestEnv({ ...settings, CLERK_JWT_KEY: jwtKey }),
		);
		const token = await new SignJWT({ azp: preview })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_preview")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const response = await app.handle(
			new Request("https://api.example.test/protected/me", {
				headers: { origin: preview, authorization: `Bearer ${token}` },
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe(preview);
		const preflight = await app.handle(
			new Request("https://api.example.test/test-cases", {
				method: "OPTIONS",
				headers: {
					origin: preview,
					"access-control-request-method": "POST",
					"access-control-request-headers": "authorization,content-type",
				},
			}),
		);
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe(preview);
	});

	it("rejects a foreign token even when the request claims an allowed Origin", async () => {
		const { privateKey, jwtKey } = await getAuthFixture();
		const { app } = createApp(
			createTestEnv({ ...settings, CLERK_JWT_KEY: jwtKey }),
		);
		const token = await new SignJWT({ azp: "https://foreign.vercel.app" })
			.setProtectedHeader({ alg: "RS256" })
			.setSubject("user_foreign")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const response = await app.handle(
			new Request("https://api.example.test/protected/me", {
				headers: { origin: preview, authorization: `Bearer ${token}` },
			}),
		);
		expect(response.status).toBe(401);
	});

	it("rejects neighbouring projects, teams, HTTP, ports and deceptive URLs", () => {
		const runtime = buildRuntimeConfig(parseEnv(createTestEnv(settings)));
		expect(isVercelPreviewOrigin(runtime, preview)).toBe(true);
		for (const origin of [
			"https://other-project-abc-namdien177s-projects.vercel.app",
			"https://jittler-lamp-desktop-abc-other-team.vercel.app",
			preview.replace("https:", "http:"),
			`${preview}:8443`,
			`${preview}/path`,
			`${preview}?next=1`,
			`${preview}#fragment`,
			`${preview}.evil.test`,
			preview.replace("https://", "https://user@"),
			"https://jittler-lamp-desktop-abc.evil-namdien177s-projects.vercel.app",
			"https://jittler-lamp-desktop-abc-evil-namdien177s-projects.vercel.app",
			"https://jittler-lamp-desktop-other-project-928kf0wfz-namdien177s-projects.vercel.app",
			"https://jittler-lamp-desktop-git-feat-namdien177s-projects.vercel.app",
		])
			expect(isVercelPreviewOrigin(runtime, origin)).toBe(false);
		expect(
			isVercelPreviewOrigin({ ...runtime, nodeEnv: "production" }, preview),
		).toBe(false);
	});

	it("refuses preview configuration with a production runtime, live Clerk key or partial project scope", () => {
		const base = createTestEnv(settings);
		expect(() => parseEnv(base)).not.toThrow();
		expect(() =>
			parseEnv({
				...base,
				NODE_ENV: "production",
				S3_BUCKET: "bucket",
				S3_REGION: "us-east-1",
				S3_ACCESS_KEY_ID: "fixture-id",
				S3_SECRET_ACCESS_KEY: "fixture-secret",
			}),
		).toThrow("Vercel preview origins");
		expect(() =>
			parseEnv({ ...base, CLERK_PUBLISHABLE_KEY: "pk_live_fixture" }),
		).toThrow("Vercel preview origins");
		expect(() =>
			parseEnv({ ...base, CLERK_SECRET_KEY: "sk_live_fixture" }),
		).toThrow("Vercel preview origins");
		const runtime = buildRuntimeConfig(parseEnv(base));
		expect(
			isVercelPreviewOrigin(
				{ ...runtime, clerkSecretKey: "sk_live_fixture" },
				preview,
			),
		).toBe(false);
		expect(() => parseEnv({ ...base, VERCEL_PREVIEW_TEAM: undefined })).toThrow(
			"Vercel preview origins",
		);
		expect(() => parseEnv({ ...base, VERCEL_PREVIEW_PROJECT: "*" })).toThrow();
	});
});
