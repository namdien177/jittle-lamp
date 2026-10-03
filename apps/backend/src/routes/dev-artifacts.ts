import { Elysia } from "elysia";

import { createApiError } from "../http/api-error";
import type { CorePlugin } from "../plugins/core";
import {
	DEV_ARTIFACT_ROUTE,
	devArtifactReadEnabled,
	verifyDevArtifactToken,
} from "../services/artifact-storage";

// DEV ONLY (see devArtifactReadEnabled): streams in-memory artifacts behind signed, expiring
// URLs so the web viewer can play evidence against a local dev-auth backend. app.ts mounts it
// only when storage is in memory mode and dev auth is enabled in a development runtime.
export const createDevArtifactRoutes = (core: CorePlugin) =>
	new Elysia({ name: "dev-artifact-routes" })
		.use(core)
		.get(
			`${DEV_ARTIFACT_ROUTE}/:token`,
			async ({ artifactStorage, params, request, requestId, runtime, set }) => {
				const secret = runtime.secret;
				const verified =
					devArtifactReadEnabled(runtime) && secret
						? verifyDevArtifactToken(secret, String(params.token))
						: null;
				if (!verified || artifactStorage.mode !== "memory") {
					set.status = 404;
					return createApiError(requestId, "NOT_FOUND", "Not found", 404);
				}
				let body: Uint8Array;
				try {
					body = await artifactStorage.getObject({ key: verified.key });
				} catch {
					set.status = 404;
					return createApiError(requestId, "NOT_FOUND", "Not found", 404);
				}
				const headers: Record<string, string> = {
					"content-type": verified.contentType,
					"accept-ranges": "bytes",
					"cache-control": "private, max-age=60",
				};
				const range = /^bytes=(\d*)-(\d*)$/.exec(
					request.headers.get("range") ?? "",
				);
				if (range && (range[1] || range[2])) {
					const size = body.byteLength;
					const start = range[1]
						? Number(range[1])
						: Math.max(0, size - Number(range[2]));
					const end = range[1] && range[2] ? Number(range[2]) : size - 1;
					if (start >= size || end < start) {
						return new Response(null, {
							status: 416,
							headers: { ...headers, "content-range": `bytes */${size}` },
						});
					}
					const slice = body.subarray(start, Math.min(end, size - 1) + 1);
					return new Response(Uint8Array.from(slice).buffer, {
						status: 206,
						headers: {
							...headers,
							"content-range": `bytes ${start}-${start + slice.byteLength - 1}/${size}`,
							"content-length": String(slice.byteLength),
						},
					});
				}
				return new Response(Uint8Array.from(body).buffer, {
					headers: { ...headers, "content-length": String(body.byteLength) },
				});
			},
		);
