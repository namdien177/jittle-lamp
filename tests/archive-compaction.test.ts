import { describe, expect, test } from "bun:test";

import {
  compactSessionArchive,
  maskSecretValue,
  maskSensitiveUrl,
  sessionArchiveSchema,
  sessionSchemaVersion,
  type SessionArchive
} from "@jittle-lamp/shared";

import { makeDesktopRecorderArchive } from "./fixtures/desktop-recorder-archive";

const at = "2026-01-01T00:00:00.000Z";
let seq = 0;

function network(input: {
  method?: string;
  url: string;
  subtype?: string;
  status?: number;
  requestHeaders?: Array<{ name: string; value: string }>;
  responseHeaders?: Array<{ name: string; value: string }>;
  requestBody?: Record<string, unknown>;
  responseBody?: Record<string, unknown>;
}) {
  seq += 1;
  return {
    id: `net-${seq}`,
    seq,
    at,
    subtype: input.subtype ?? "fetch",
    payload: {
      kind: "network",
      method: input.method ?? "GET",
      url: input.url,
      status: input.status ?? 200,
      request: { headers: input.requestHeaders ?? [], cookies: [], ...(input.requestBody ? { body: input.requestBody } : {}) },
      response: {
        headers: input.responseHeaders ?? [],
        setCookieHeaders: [],
        setCookies: [],
        ...(input.responseBody ? { body: input.responseBody } : {})
      }
    }
  };
}

function consoleEntry(message: string, level = "error") {
  seq += 1;
  return { id: `con-${seq}`, seq, at, payload: { kind: "console", level, message, args: [] } };
}

function makeArchive(sections: { network?: unknown[]; console?: unknown[] }): SessionArchive {
  return sessionArchiveSchema.parse({
    schemaVersion: sessionSchemaVersion,
    sessionId: "jl_compaction",
    name: "Compaction",
    createdAt: at,
    updatedAt: at,
    phase: "ready",
    page: { title: "Example", url: "https://app.example.com/" },
    summary: { videoDurationMs: null, actionCount: 0, requestCount: sections.network?.length ?? 0 },
    artifacts: [],
    sections: { actions: [], console: sections.console ?? [], network: sections.network ?? [] }
  });
}

describe("archive compaction", () => {
  test("masks secrets to their first and last four characters", () => {
    expect(maskSecretValue("abcdefghijklmnopqrstuvwxyz")).toBe("abcd****wxyz");
    expect(maskSecretValue("short")).toBe("****");
    expect(maskSecretValue("abcd****wxyz")).toBe("abcd****wxyz");
    expect(maskSensitiveUrl("https://api.example.com/cb?code=0123456789abcdef&page=2")).toBe(
      "https://api.example.com/cb?code=0123****cdef&page=2"
    );
    expect(maskSensitiveUrl("https://api.example.com/items?page=2")).toBe("https://api.example.com/items?page=2");
  });

  test("keeps headers but masks their sensitive values", () => {
    const archive = compactSessionArchive(
      makeArchive({
        network: [
          network({
            method: "POST",
            url: "https://api.example.com/login",
            requestHeaders: [
              { name: "Authorization", value: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature" },
              { name: "Cookie", value: "sid=s3cr3t-session-value-123; theme=dark" },
              { name: "Accept", value: "application/json" }
            ],
            responseHeaders: [{ name: "Set-Cookie", value: "sid=another-session-value-456; Path=/; HttpOnly" }],
            requestBody: {
              disposition: "captured",
              encoding: "utf8",
              mimeType: "application/json",
              value: JSON.stringify({ email: "qa@example.com", password: "correct-horse-battery", author: "Sam" })
            }
          })
        ]
      })
    );
    const payload = archive.sections.network[0]?.payload;
    expect(payload?.request.headers).toEqual([
      { name: "Authorization", value: "Bearer eyJh****ture" },
      { name: "Cookie", value: "sid=s3cr****-123; theme=****" },
      { name: "Accept", value: "application/json" }
    ]);
    expect(payload?.response?.headers).toEqual([{ name: "Set-Cookie", value: "sid=anot****-456; Path=/; HttpOnly" }]);
    expect(JSON.parse(payload?.request.body?.value ?? "{}")).toEqual({
      email: "qa@example.com",
      password: "corr****tery",
      author: "Sam"
    });
  });

  test("drops preflights, analytics and asset bodies but keeps the asset summary", () => {
    const archive = compactSessionArchive(
      makeArchive({
        network: [
          network({ method: "OPTIONS", url: "https://api.example.com/items", status: 204 }),
          network({ method: "POST", url: "https://www.google-analytics.com/g/collect?v=2" }),
          network({ method: "POST", url: "https://o1.ingest.sentry.io/api/1/envelope/" }),
          network({
            url: "https://cdn.example.com/logo.png",
            subtype: "image",
            status: 404,
            requestHeaders: [{ name: "Accept", value: "image/*" }],
            responseHeaders: [
              { name: "Content-Type", value: "image/png" },
              { name: "Content-Length", value: "2048" },
              { name: "ETag", value: "abc" }
            ],
            responseBody: { disposition: "captured", encoding: "base64", mimeType: "image/png", value: "iVBORw0KGgo=", byteLength: 2048 }
          }),
          network({
            url: "https://api.example.com/report.pdf",
            responseBody: { disposition: "captured", encoding: "base64", mimeType: "application/pdf", value: "JVBERi0=", byteLength: 5 }
          }),
          network({
            url: "https://api.example.com/items",
            responseBody: { disposition: "captured", encoding: "utf8", mimeType: "application/json", value: "[1,2]", byteLength: 5 }
          })
        ]
      })
    );

    expect(archive.sections.network.map((entry) => entry.payload.url)).toEqual([
      "https://cdn.example.com/logo.png",
      "https://api.example.com/report.pdf",
      "https://api.example.com/items"
    ]);
    const [asset, pdf, json] = archive.sections.network.map((entry) => entry.payload);
    expect(asset?.status).toBe(404);
    expect(asset?.request.headers).toEqual([]);
    expect(asset?.response?.headers.map((header) => header.name)).toEqual(["Content-Type", "Content-Length"]);
    expect(asset?.response?.body).toMatchObject({ disposition: "omitted", byteLength: 2048 });
    expect(asset?.response?.body?.value).toBeUndefined();
    expect(pdf?.response?.body).toMatchObject({ disposition: "omitted", mimeType: "application/pdf", byteLength: 5 });
    expect(json?.response?.body?.value).toBe("[1,2]");
    expect(archive.summary.requestCount).toBe(3);
    expect(archive.notes.at(-1)).toContain("removed 1 CORS preflight (OPTIONS) requests");
    expect(archive.notes.at(-1)).toContain("removed 2 analytics requests");
  });

  test("collapses repeated console lines in a row", () => {
    const archive = compactSessionArchive(
      makeArchive({
        console: [consoleEntry("Boom"), consoleEntry("Boom"), consoleEntry("Boom"), consoleEntry("Other"), consoleEntry("Boom")]
      })
    );
    expect(archive.sections.console.map((entry) => entry.payload.message)).toEqual(["Boom (×3)", "Other", "Boom"]);
  });

  test("gives the same result when run twice", () => {
    const once = compactSessionArchive(
      makeArchive({
        network: [
          network({ method: "OPTIONS", url: "https://api.example.com/items", status: 204 }),
          network({ url: "https://api.example.com/items?token=0123456789abcdef", requestHeaders: [{ name: "x-api-key", value: "key-0123456789" }] })
        ],
        console: [consoleEntry("Boom"), consoleEntry("Boom")]
      })
    );
    expect(compactSessionArchive(once)).toEqual(once);
  });
});

// The macOS app's unified-log lines are console entries; the existing console rules cover them.
describe("archive compaction: desktop recorder archives", () => {
  test("caps a chatty unified log, keeping warnings and errors and the recorder untouched", () => {
    const written = makeDesktopRecorderArchive({ consoleLines: 3100 });
    const archive = compactSessionArchive(written);
    expect(archive.recorder).toEqual(written.recorder);
    expect(archive.page).toEqual(written.page);
    expect(archive.artifacts).toEqual(written.artifacts);
    expect(archive.summary.requestCount).toBeNull();
    // 3099 identical info lines collapse into one, so nothing has to be dropped.
    expect(archive.sections.console.map((entry) => entry.payload.message)).toEqual([
      "WebContent: networking idle (×3099)",
      "WebContent: failed to load checkout"
    ]);
    expect(archive.notes.at(-1)).toBe("Archive compaction: collapsed 3098 repeated console lines.");
    expect(compactSessionArchive(archive)).toEqual(archive);
  });
});
