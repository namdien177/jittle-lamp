import { describe, expect, it } from "bun:test";

import { createApp } from "../src/app";
import { createTestEnv } from "./test-utils";

const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

describe("dev-only memory artifact reads", () => {
	it("serves in-memory artifacts through signed URLs when dev auth is enabled", async () => {
		const { app, artifactStorage } = createApp(
			createTestEnv({
				JITTLE_LAMP_DEV_AUTH_ENABLED: "true",
				LOG_LEVEL: "error",
			}),
		);
		expect(artifactStorage.mode).toBe("memory");
		const key = `uploads/dev/${crypto.randomUUID()}`;
		await artifactStorage.putObject({
			key,
			body,
			contentType: "video/webm",
			checksumSha256: "",
		});
		const signed = await artifactStorage.createReadUrl({
			key,
			responseContentType: "video/webm",
		});
		const url = new URL(signed.url);
		expect(url.origin).toBe("http://127.0.0.1:3001");
		expect(url.pathname.startsWith("/dev/artifacts/")).toBe(true);
		expect(signed.ttlSeconds).toBe(900);

		const full = await app.handle(
			new Request(`http://localhost${url.pathname}`),
		);
		expect(full.status).toBe(200);
		expect(full.headers.get("content-type")).toBe("video/webm");
		expect(new Uint8Array(await full.arrayBuffer())).toEqual(body);

		const partial = await app.handle(
			new Request(`http://localhost${url.pathname}`, {
				headers: { range: "bytes=2-4" },
			}),
		);
		expect(partial.status).toBe(206);
		expect(partial.headers.get("content-range")).toBe("bytes 2-4/10");
		expect(new Uint8Array(await partial.arrayBuffer())).toEqual(
			new Uint8Array([3, 4, 5]),
		);

		const tampered = url.pathname.replace(/.$/, (char) =>
			char === "A" ? "B" : "A",
		);
		expect(
			(await app.handle(new Request(`http://localhost${tampered}`))).status,
		).toBe(404);
	});

	it("stays off without dev auth or outside development", async () => {
		const plain = createApp(createTestEnv({ LOG_LEVEL: "error" }));
		await expect(
			plain.artifactStorage.createReadUrl({
				key: "uploads/x",
				responseContentType: "video/webm",
			}),
		).rejects.toThrow(/S3 storage is not configured/);
		expect(
			(
				await plain.app.handle(
					new Request("http://localhost/dev/artifacts/x.y"),
				)
			).status,
		).toBe(404);

		const staging = createApp(
			createTestEnv({
				NODE_ENV: "staging",
				JITTLE_LAMP_DEV_AUTH_ENABLED: "true",
				LOG_LEVEL: "error",
			}),
		);
		await expect(
			staging.artifactStorage.createReadUrl({
				key: "uploads/x",
				responseContentType: "video/webm",
			}),
		).rejects.toThrow(/S3 storage is not configured/);
	});
});
