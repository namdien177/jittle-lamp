import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { BrowserContext, ConsoleMessage, Page, Request, Response, WebError } from "playwright-core";

import { createRedactor } from "../redact";

// Network, console and navigation capture inside the e2e worker (roadmap 2026-10-13 §1.1, phase
// A). e2e 0.19 removed the Playwright trace the session archive was built from, so the engine
// wrapper listens on the attempt's BrowserContext itself and appends one JSON line per record to
// `requests.jsonl`, `console.jsonl` and `navigations.jsonl` under JL_CAPTURE_DIR. The archive
// builder (evidence/archive.ts) turns these into archive v4 sections after the run.
//
// Rules: listeners never block the page (body reads are fire-and-forget, errors swallowed);
// sensitive headers are replaced at capture time; every text field passes the worker's redactor
// (values of the env names in JL_REDACT_ENVS) before it is written, so no run artifact on disk
// holds a secret. This module runs inside the e2e worker: no @jittle-lamp/shared imports.

export type CapturedBody = {
  disposition: "captured" | "truncated" | "omitted" | "unavailable";
  encoding?: "utf8";
  mimeType?: string;
  value?: string;
  byteLength?: number;
  omittedByteLength?: number;
  reason?: string;
};

export type CapturedHeader = { name: string; value: string };

export type CapturedRequest = {
  kind: "request";
  seq: number;
  startedAt: string;
  finishedAt: string | null;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: CapturedHeader[];
  requestBody?: CapturedBody;
  status?: number;
  statusText?: string;
  responseHeaders?: CapturedHeader[];
  responseBody?: CapturedBody;
  durationMs: number | null;
  failureText?: string;
};

export type CapturedConsole = {
  kind: "console";
  seq: number;
  at: string;
  source: "console" | "pageerror";
  level: "error" | "warn" | "info" | "debug";
  message: string;
  location?: string;
};

export type CapturedNavigation = {
  kind: "navigation";
  seq: number;
  at: string;
  url: string;
  event: "page-opened" | "navigated";
};

export const maxCapturedBodyBytes = 64 * 1024;
// How long a response body may take to arrive once its headers have; longer reads are given up.
export const bodyReadTimeoutMs = 10_000;
export const sensitiveHeaderNames = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token", "x-csrf-token"]);
export const textMimePattern = /^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded|graphql)|[^;]*\+json|[^;]*\+xml)/i;

// A header value is kept unless its name is sensitive; the redactor then catches a secret that
// travelled in any other header.
export function captureHeaders(headers: Readonly<Record<string, string>>, redact: (text: string) => string): CapturedHeader[] {
  return Object.entries(headers).flatMap(([name, value]) => {
    if (name.length === 0) return [];
    return [{ name, value: sensitiveHeaderNames.has(name.toLowerCase()) ? "[redacted]" : redact(String(value ?? "")) }];
  });
}

// Same rule as the trace-based archive had: text bodies up to 64 KiB, binary bodies by size only.
export function captureBody(raw: Uint8Array | null, mimeType: string | undefined, redact: (text: string) => string): CapturedBody | undefined {
  if (!raw) return undefined;
  if (raw.byteLength === 0) return undefined;
  if (mimeType && !textMimePattern.test(mimeType)) {
    return { disposition: "omitted", mimeType, byteLength: raw.byteLength, reason: "binary body" };
  }
  const truncated = raw.byteLength > maxCapturedBodyBytes;
  const value = redact(new TextDecoder().decode(truncated ? raw.slice(0, maxCapturedBodyBytes) : raw));
  return {
    disposition: truncated ? "truncated" : "captured",
    encoding: "utf8",
    ...(mimeType ? { mimeType } : {}),
    value,
    byteLength: raw.byteLength,
    ...(truncated ? { omittedByteLength: raw.byteLength - maxCapturedBodyBytes } : {})
  };
}

function mimeOf(headers: Readonly<Record<string, string>>): string | undefined {
  const value = headers["content-type"];
  if (!value) return undefined;
  return value.split(";")[0]?.trim() || undefined;
}

// Secret values the worker knows: the env names the runner listed in JL_REDACT_ENVS, plus the
// keys inside the model accounts JSON (one value holding several secrets).
export function secretsFromEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  const values = new Set<string>();
  for (const name of (env.JL_REDACT_ENVS ?? "").split(",")) {
    const value = name ? env[name] : undefined;
    if (value) values.add(value);
  }
  if (env.JL_MODEL_ACCOUNTS) {
    try {
      const accounts = JSON.parse(env.JL_MODEL_ACCOUNTS) as Array<{ apiKey?: unknown }>;
      for (const account of Array.isArray(accounts) ? accounts : []) {
        if (typeof account?.apiKey === "string" && account.apiKey) values.add(account.apiKey);
      }
    } catch {
      // not JSON: nothing to add
    }
  }
  return [...values];
}

export type CaptureHandle = {
  // Waits for in-flight body reads (bounded), then writes requests that never finished.
  flush: (timeoutMs?: number) => Promise<void>;
};

type PendingRequest = { record: CapturedRequest; startedMs: number; written: boolean };

export function installCapture(context: BrowserContext, options: { dir: string; redact: (text: string) => string }): CaptureHandle {
  mkdirSync(options.dir, { recursive: true });
  const redact = options.redact;
  const files = {
    requests: join(options.dir, "requests.jsonl"),
    console: join(options.dir, "console.jsonl"),
    navigations: join(options.dir, "navigations.jsonl")
  };
  const write = (file: string, record: unknown) => {
    try {
      appendFileSync(file, `${JSON.stringify(record)}\n`);
    } catch {
      // Capture must never fail the run.
    }
  };

  let seq = 0;
  const pending = new Map<Request, PendingRequest>();
  const inFlight = new Set<Promise<void>>();
  const track = (promise: Promise<void>) => {
    const guarded = promise.catch(() => undefined).finally(() => inFlight.delete(guarded));
    inFlight.add(guarded);
  };
  const finish = (entry: PendingRequest) => {
    if (entry.written) return;
    entry.written = true;
    write(files.requests, entry.record);
  };

  const onRequest = (request: Request) => {
    const url = request.url();
    // Only app traffic: data:, blob: and chrome-extension: URLs carry nothing a reviewer needs.
    if (!/^https?:/i.test(url)) return;
    const startedMs = Date.now();
    const headers = request.headers();
    let requestBody: CapturedBody | undefined;
    try {
      requestBody = captureBody(request.postDataBuffer(), mimeOf(headers), redact);
    } catch {
      requestBody = undefined;
    }
    seq += 1;
    pending.set(request, {
      startedMs,
      written: false,
      record: {
        kind: "request",
        seq,
        startedAt: new Date(startedMs).toISOString(),
        finishedAt: null,
        method: request.method(),
        url: redact(url),
        resourceType: request.resourceType(),
        requestHeaders: captureHeaders(headers, redact),
        ...(requestBody ? { requestBody } : {}),
        durationMs: null
      }
    });
  };

  const onResponse = (response: Response) => {
    const entry = pending.get(response.request());
    if (!entry) return;
    const headers = response.headers();
    const headersMs = Date.now();
    entry.record.status = response.status();
    entry.record.statusText = response.statusText();
    entry.record.responseHeaders = captureHeaders(headers, redact);
    const mimeType = mimeOf(headers);
    const status = response.status();
    track(
      (async () => {
        // No body to read for these; `body()` would reject.
        const bodiless = status === 204 || status === 304 || (status >= 300 && status < 400);
        // A page that navigates right after a fetch unloads the resource before Chromium reports
        // it finished; the read is bounded so the record is still written, body or not.
        const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), bodyReadTimeoutMs));
        let done = false;
        if (!bodiless && mimeType && textMimePattern.test(mimeType)) {
          const read = response
            .body()
            .then((raw) => {
              const body = captureBody(raw, mimeType, redact);
              if (body) entry.record.responseBody = body;
              return "read" as const;
            })
            .catch(() => "failed" as const);
          const outcome = await Promise.race([read, timer]);
          done = outcome === "read";
          if (outcome !== "read") {
            entry.record.responseBody = {
              disposition: "unavailable",
              mimeType,
              reason: outcome === "timeout" ? "body not reported before the page moved on" : "body could not be read"
            };
          }
        } else {
          if (!bodiless && mimeType) entry.record.responseBody = { disposition: "omitted", mimeType, reason: "binary body" };
          done = (await Promise.race([response.finished().then(() => "read" as const, () => "failed" as const), timer])) === "read";
        }
        // Without a reported finish, the headers' arrival stands in for the end of the request.
        const finishedMs = done ? Date.now() : headersMs;
        entry.record.finishedAt = new Date(finishedMs).toISOString();
        entry.record.durationMs = finishedMs - entry.startedMs;
        pending.delete(response.request());
        finish(entry);
      })()
    );
  };

  const onRequestFailed = (request: Request) => {
    const entry = pending.get(request);
    if (!entry) return;
    const finishedMs = Date.now();
    entry.record.finishedAt = new Date(finishedMs).toISOString();
    entry.record.durationMs = finishedMs - entry.startedMs;
    entry.record.failureText = redact(request.failure()?.errorText ?? "request failed");
    pending.delete(request);
    finish(entry);
  };

  const onConsole = (message: ConsoleMessage) => {
    const type = message.type();
    const level: CapturedConsole["level"] =
      type === "error" ? "error" : type === "warning" ? "warn" : type === "debug" || type === "trace" ? "debug" : "info";
    seq += 1;
    const location = message.location().url;
    write(files.console, {
      kind: "console",
      seq,
      at: new Date().toISOString(),
      source: "console",
      level,
      message: redact(message.text()),
      ...(location ? { location: redact(location) } : {})
    } satisfies CapturedConsole);
  };

  const onWebError = (webError: WebError) => {
    seq += 1;
    const error = webError.error();
    write(files.console, {
      kind: "console",
      seq,
      at: new Date().toISOString(),
      source: "pageerror",
      level: "error",
      message: redact(error.message || String(error))
    } satisfies CapturedConsole);
  };

  const navigation = (url: string, event: CapturedNavigation["event"]) => {
    if (!/^https?:/i.test(url)) return;
    seq += 1;
    write(files.navigations, { kind: "navigation", seq, at: new Date().toISOString(), url: redact(url), event } satisfies CapturedNavigation);
  };
  const onPage = (page: Page) => {
    navigation(page.url(), "page-opened");
    page.on("framenavigated", (frame) => {
      // Child frames navigate on their own; the timeline follows the top document only.
      if (frame.parentFrame() !== null) return;
      navigation(frame.url(), "navigated");
    });
  };

  context.on("request", onRequest);
  context.on("response", onResponse);
  context.on("requestfailed", onRequestFailed);
  context.on("console", onConsole);
  context.on("weberror", onWebError);
  context.on("page", onPage);
  for (const page of context.pages()) onPage(page);

  return {
    async flush(timeoutMs = bodyReadTimeoutMs + 1000) {
      const deadline = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
      await Promise.race([Promise.all([...inFlight]), deadline]);
      // Requests still open when the attempt ends are written without a response.
      for (const entry of pending.values()) finish(entry);
      pending.clear();
    }
  };
}

// The capture the engine installs per attempt: configured by the runner through JL_CAPTURE_DIR.
export function installCaptureFromEnv(context: BrowserContext, env: Readonly<Record<string, string | undefined>> = process.env): CaptureHandle | null {
  const dir = env.JL_CAPTURE_DIR;
  if (!dir) return null;
  return installCapture(context, { dir, redact: createRedactor(secretsFromEnv(env)) });
}
