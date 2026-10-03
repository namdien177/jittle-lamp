import {
  cacheEntryReadResponseSchema,
  claimRunResponseSchema,
  liveControlResponseSchema,
  type LiveControlResponse,
  createTestRunResponseSchema,
  explorationConfigSchema,
  registerRunnerResponseSchema,
  testRunConfigSchema,
  testRunDetailSchema,
  testRunProgressResponseSchema,
  type ClaimedExploration,
  type ClaimedRun,
  type CreateTestRunRequest,
  type ExplorationConfig,
  type ExplorationResultRequest,
  type FinalizeTestRunRequest,
  type TestRunConfig,
  type TestRunProgressRequest
} from "@jittle-lamp/shared";
import type { z } from "zod/v4";

// Typed client for the backend routes a runner and the CLI call (contract: packages/shared/src/test-api.ts).

export class BackendError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = "BackendError";
  }
}

export type BackendClientOptions = { origin: string; fetch?: typeof fetch; userAgent?: string };

export class BackendClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: BackendClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async request<S extends z.ZodType>(
    method: string,
    path: string,
    token: string,
    schema: S | null,
    body?: unknown,
    contentType = "application/json"
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, "user-agent": this.options.userAgent ?? "jl-e2e" };
    let payload: BodyInit | undefined;
    if (body instanceof Uint8Array) {
      headers["content-type"] = contentType;
      payload = body as unknown as BodyInit;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    // A hung request must not hold the lease keep-alive chain; uploads get longer.
    const timeoutMs = body instanceof Uint8Array ? 300_000 : 30_000;
    const response = await this.fetchImpl(new URL(path, this.options.origin), {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(payload === undefined ? {} : { body: payload })
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      const error = (json ?? {}) as { code?: string; message?: string; error?: { code?: string; message?: string }; retryAfter?: number };
      const code = error.code ?? error.error?.code ?? null;
      const message = error.message ?? error.error?.message ?? (text.slice(0, 300) || response.statusText);
      const retryAfter = Number(response.headers.get("retry-after") ?? error.retryAfter ?? Number.NaN);
      throw new BackendError(response.status, code, `${method} ${path} → ${response.status} ${code ?? ""} ${message}`.trim(), Number.isFinite(retryAfter) ? retryAfter : null);
    }
    return (schema ? schema.parse(json) : json) as z.infer<S>;
  }

  register(registrationToken: string, body: { hostname: string; version: string; capabilities: { browsers: string[]; headed: boolean; liveView: boolean } }) {
    return this.request("POST", "/runner-pools/register", registrationToken, registerRunnerResponseSchema, body);
  }

  heartbeat(workerToken: string, runId: string | null, load: number) {
    return this.request("POST", "/runner-pools/heartbeat", workerToken, null, { runId, load });
  }

  async claim(workerToken: string): Promise<ClaimedRun | null> {
    return (await this.claimWork(workerToken)).run;
  }

  // A run, or when the pool has none queued, an import item to explore.
  claimWork(workerToken: string): Promise<{ run: ClaimedRun | null; exploration: ClaimedExploration | null }> {
    return this.request("POST", "/runner-pools/claim", workerToken, claimRunResponseSchema, {});
  }

  explorationConfig(workerToken: string, explorationId: string): Promise<ExplorationConfig> {
    return this.request("GET", `/test-explorations/${encodeURIComponent(explorationId)}/config`, workerToken, explorationConfigSchema);
  }

  async explorationResult(workerToken: string, explorationId: string, body: ExplorationResultRequest): Promise<void> {
    await this.request("POST", `/test-explorations/${encodeURIComponent(explorationId)}/result`, workerToken, null, body);
  }

  config(runId: string, runToken: string): Promise<TestRunConfig> {
    return this.request("GET", `/test-runs/${encodeURIComponent(runId)}/config`, runToken, testRunConfigSchema);
  }

  progress(runId: string, runToken: string, body: TestRunProgressRequest) {
    return this.request("PATCH", `/test-runs/${encodeURIComponent(runId)}/progress`, runToken, testRunProgressResponseSchema, body);
  }

  async uploadEvidence(runId: string, runToken: string, zip: Uint8Array): Promise<string> {
    const result = (await this.request("POST", `/test-runs/${encodeURIComponent(runId)}/evidence`, runToken, null, zip, "application/zip")) as { evidenceId?: string };
    if (!result?.evidenceId) throw new BackendError(500, null, "evidence upload returned no evidenceId");
    return result.evidenceId;
  }

  // The reply (the finalised run) is informational for the runner; only the status matters.
  async finalize(runId: string, runToken: string, body: FinalizeTestRunRequest): Promise<void> {
    await this.request("POST", `/test-runs/${encodeURIComponent(runId)}/finalize`, runToken, null, body);
  }

  cacheRead(runId: string, runToken: string, keyHash: string) {
    return this.request("GET", `/test-runs/${encodeURIComponent(runId)}/cache/${encodeURIComponent(keyHash)}`, runToken, cacheEntryReadResponseSchema);
  }

  cacheWrite(runId: string, runToken: string, keyHash: string, body: { entry: unknown; stepIds: string[]; instructionKey: string | null; renderedCode: string }) {
    return this.request("PUT", `/test-runs/${encodeURIComponent(runId)}/cache/${encodeURIComponent(keyHash)}`, runToken, null, body);
  }

  async liveControl(runId: string, runToken: string, after: number): Promise<LiveControlResponse | null> {
    try {
      return await this.request("GET", `/test-runs/${encodeURIComponent(runId)}/live/control?after=${after}`, runToken, liveControlResponseSchema);
    } catch (error) {
      // A backend without live view answers 404; the run goes on without it.
      if (error instanceof BackendError && error.status === 404) return null;
      throw error;
    }
  }

    liveFrame(runId: string, runToken: string, jpeg: Uint8Array) {
    return this.request("PUT", `/test-runs/${encodeURIComponent(runId)}/live/frame`, runToken, null, jpeg, "image/jpeg");
  }

  // A secret was typed: the backend serves a placeholder instead of frames from now on.
  liveFramesHidden(runId: string, runToken: string) {
    return this.request("PUT", `/test-runs/${encodeURIComponent(runId)}/live/frame`, runToken, null, new Uint8Array(), "application/vnd.jl.frame-hidden");
  }

  createRun(testCaseId: string, token: string, body: Partial<CreateTestRunRequest>) {
    return this.request("POST", `/test-cases/${encodeURIComponent(testCaseId)}/runs`, token, createTestRunResponseSchema, body);
  }

  createSuiteRun(suiteId: string, token: string, body: Partial<CreateTestRunRequest>) {
    return this.request("POST", `/test-suites/${encodeURIComponent(suiteId)}/runs`, token, createTestRunResponseSchema, body);
  }

  getRun(runId: string, token: string) {
    return this.request("GET", `/test-runs/${encodeURIComponent(runId)}`, token, testRunDetailSchema);
  }
}
