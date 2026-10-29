import { afterEach, describe, expect, test } from "bun:test";
import { canonicalArchiveBundles, canonicalZipBundles } from "./fixtures/canonical-fixtures";

import { createWebSessionStrategies } from "../apps/evidence-web/src/session-strategy";

const SESSION_ID = canonicalArchiveBundles.small.sessionId;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("web session strategies", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });


  test("local ZIP strategy supports canonical small/medium/large bundles", async () => {
    const strategies = createWebSessionStrategies();

    for (const [size, zipBytes] of Object.entries(canonicalZipBundles)) {
      const expectedArchive = canonicalArchiveBundles[size as keyof typeof canonicalArchiveBundles];
      const zipFile = new File([toArrayBuffer(zipBytes)], `${size}.zip`, { type: "application/zip" });
      const payload = await strategies.local.load(zipFile);

      expect(payload.archive.sessionId).toBe(expectedArchive.sessionId);
      expect(payload.archive.sections.actions.length).toBe(expectedArchive.sections.actions.length);
      expect(payload.archive.sections.network.length).toBeGreaterThan(0);
      expect(payload.archive.annotations.some((annotation) => annotation.kind === "merge-group")).toBe(true);
    }
  });

  test("local ZIP strategy works offline with fetch disabled", async () => {
    globalThis.fetch = ((() => {
      throw new Error("network disabled");
    }) as unknown) as typeof fetch;

    const zipFile = new File([toArrayBuffer(canonicalZipBundles.small)], "session.zip", { type: "application/zip" });
    const payload = await createWebSessionStrategies().local.load(zipFile);

    expect(payload.archive.sessionId).toBe(SESSION_ID);
    expect(payload.videoUrl.startsWith("blob:")).toBe(true);
  });

  test("remote ZIP strategy is additive and can load without auth", async () => {
    globalThis.fetch = (async (_url: string | URL | Request) => {
      return new Response(toArrayBuffer(canonicalZipBundles.small), {
        status: 200,
        headers: { "content-type": "application/zip" }
      });
    }) as typeof fetch;

    const payload = await createWebSessionStrategies().remote.load({ zipUrl: "https://example.test/session.zip" });
    expect(payload.archive.sessionId).toBe(SESSION_ID);
  });

  test("remote ZIP strategy forwards bearer auth when provided", async () => {
    let authHeader = "";
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authHeader = headers.get("authorization") ?? "";
      return new Response(toArrayBuffer(canonicalZipBundles.small), { status: 200 });
    }) as typeof fetch;

    await createWebSessionStrategies().remote.load({
      zipUrl: "https://example.test/secure.zip",
      authToken: "token-123"
    });

    expect(authHeader).toBe("Bearer token-123");
  });
});
