import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { parseEnv } from "../src/config/env";
import { buildRuntimeConfig } from "../src/config/runtime";
import { createArtifactStorage } from "../src/services/artifact-storage";
import { createTestEnv } from "./test-utils";

describe("S3 environment isolation", () => {
	it("scopes writes, reads, signed links and deletion to the configured namespace", async () => {
		const paths: string[] = [];
		const body = new TextEncoder().encode("fixture artifact");
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				paths.push(`${request.method} ${new URL(request.url).pathname}`);
				return request.method === "GET"
					? new Response(body)
					: new Response(null, { status: 200 });
			},
		});
		try {
			const runtime = buildRuntimeConfig(
				parseEnv(
					createTestEnv({
						S3_BUCKET: "shared-bucket",
						S3_REGION: "us-east-1",
						S3_ACCESS_KEY_ID: "fixture-id",
						S3_SECRET_ACCESS_KEY: "fixture-secret",
						S3_ENDPOINT: server.url.origin,
						S3_FORCE_PATH_STYLE: "true",
						S3_KEY_PREFIX: "preprod",
					}),
				),
			);
			const storage = createArtifactStorage(runtime);
			await storage.putObject({
				key: "org/run/archive.json",
				body,
				contentType: "application/json",
				checksumSha256: createHash("sha256").update(body).digest("base64"),
			});
			expect(await storage.getObject({ key: "org/run/archive.json" })).toEqual(
				body,
			);
			const signed = await storage.createReadUrl({
				key: "org/run/archive.json",
				responseContentType: "application/json",
			});
			expect(new URL(signed.url).pathname).toBe(
				"/shared-bucket/preprod/org/run/archive.json",
			);
			await storage.deleteObject({ key: "org/run/archive.json" });
			expect(paths).toEqual([
				"PUT /shared-bucket/preprod/org/run/archive.json",
				"GET /shared-bucket/preprod/org/run/archive.json",
				"DELETE /shared-bucket/preprod/org/run/archive.json",
			]);
			if (!runtime.s3) throw new Error("S3 test configuration missing");
			const prod = createArtifactStorage({
				...runtime,
				s3: { ...runtime.s3, keyPrefix: undefined },
			});
			const oldUrl = await prod.createReadUrl({
				key: "org/run/archive.json",
				responseContentType: "application/json",
			});
			expect(new URL(oldUrl.url).pathname).toBe(
				"/shared-bucket/org/run/archive.json",
			);
		} finally {
			await server.stop(true);
		}
	});

	it("rejects prefixes that can escape an environment namespace", () => {
		for (const prefix of [
			"../prod",
			"/preprod",
			"preprod/../prod",
			"preprod//nested",
		]) {
			expect(() =>
				parseEnv(createTestEnv({ S3_KEY_PREFIX: prefix })),
			).toThrow();
		}
	});
});
