import { describe, expect, test } from "bun:test";

import { buildCurl, getResponseBodyString } from "@jittle-lamp/viewer-react";

import { describeRecorder } from "../packages/viewer-react/src/viewer-modal/evidence-pane";

const baseRequest = {
  kind: "network" as const,
  method: "POST",
  url: "https://example.com/api/widgets?id=42",
  request: {
    headers: [
      { name: "content-type", value: "application/json" },
      { name: "x-trace-id", value: "abc 123" }
    ],
    cookies: [],
    body: {
      disposition: "captured" as const,
      encoding: "utf8" as const,
      value: '{"name":"jonny\'s widget"}'
    }
  }
};

describe("viewer-modal — buildCurl", () => {
  test("emits headers and a quoted body", () => {
    const curl = buildCurl(baseRequest);
    expect(curl).toContain("curl -X POST 'https://example.com/api/widgets?id=42'");
    expect(curl).toContain("-H 'content-type: application/json'");
    expect(curl).toContain("-H 'x-trace-id: abc 123'");
    expect(curl).toContain("--data");
  });

  test("escapes single quotes in body", () => {
    const curl = buildCurl(baseRequest);
    // single quote in input is escaped as '\''
    expect(curl).toContain("'\\''");
  });

  test("emits base64 body marker", () => {
    const curl = buildCurl({
      ...baseRequest,
      request: {
        ...baseRequest.request,
        body: {
          disposition: "captured" as const,
          encoding: "base64" as const,
          value: "aGVsbG8="
        }
      }
    });
    expect(curl).toContain("--data-binary '@base64:aGVsbG8='");
  });

  test("omits body section when not captured", () => {
    const curl = buildCurl({
      ...baseRequest,
      request: {
        ...baseRequest.request,
        body: { disposition: "omitted" as const, reason: "too-large" }
      }
    });
    expect(curl).not.toContain("--data");
  });
});

describe("viewer-modal — getResponseBodyString", () => {
  test("returns the captured response body raw value", () => {
    const out = getResponseBodyString({
      ...baseRequest,
      response: {
        headers: [],
        setCookieHeaders: [],
        setCookies: [],
        body: { disposition: "captured" as const, encoding: "utf8" as const, value: "ok" }
      }
    });
    expect(out).toBe("ok");
  });

  test("returns empty string when no response or no body", () => {
    expect(getResponseBodyString(baseRequest)).toBe("");
  });

  test("returns empty string when body was omitted", () => {
    const out = getResponseBodyString({
      ...baseRequest,
      response: {
        headers: [],
        setCookieHeaders: [],
        setCookies: [],
        body: { disposition: "omitted" as const, reason: "binary" }
      }
    });
    expect(out).toBe("");
  });
});

describe("viewer-modal — about evidence", () => {
  test("names the macOS app and the captured app for desktop recordings", () => {
    const about = describeRecorder({
      kind: "desktop-recorder",
      recorder: {
        name: "jittle-lamp-desktop",
        version: "0.1.0",
        os: "macOS 26.1",
        source: { type: "application", name: "Safari", bundleId: "com.apple.Safari", pid: 4242 }
      }
    });
    expect(`${about.title} ${about.name}`).toBe("Recorded with Jittle Lamp for Mac");
    expect(about.rows).toEqual([
      ["App", "Safari"],
      ["Bundle ID", "com.apple.Safari"],
      ["App version", "0.1.0"],
      ["OS", "macOS 26.1"],
      ["Recorder type", "Jittle Lamp for Mac"]
    ]);
  });

  test("shows the display for screen captures", () => {
    const about = describeRecorder({
      kind: "desktop-recorder",
      recorder: { name: "jittle-lamp-desktop", version: "0.1.0", os: "macOS 26.1", source: { type: "display", name: "Built-in Retina Display" } }
    });
    expect(about.rows[0]).toEqual(["Display", "Built-in Retina Display"]);
    expect(about.rows.map(([label]) => label)).not.toContain("Bundle ID");
  });

  test("keeps the extension and runner descriptions", () => {
    expect(describeRecorder({ kind: "browser-extension", extension: { kind: "browser-extension", name: "jittle-lamp", version: "1.8.2" } }).title).toBe(
      "Extension used"
    );
    expect(describeRecorder({ kind: "e2e-runner", runner: { name: "jl-e2e", version: "1.8.2" } }).title).toBe("Runner used");
  });
});
