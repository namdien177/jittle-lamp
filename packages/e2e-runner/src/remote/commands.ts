import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  parseTranscriptDocument,
  createImportRequestSchema,
  importBatchSchema,
  serializeTestCase,
  testCaseDetailSchema,
  testCaseListResponseSchema,
  testEnvironmentSchema,
  type TestRunDetail
} from "@jittle-lamp/shared";
import { z } from "zod/v4";

import { BackendClient } from "../daemon/api";

// CLI commands that talk to the backend with an automation token (design.md §9.4, handover 1b.3).

export type RemoteContext = { client: BackendClient; token: string; log: (line: string) => void };

export function remoteContext(env: Readonly<Record<string, string | undefined>>, log: (line: string) => void, fetchImpl?: typeof fetch): RemoteContext {
  const origin = env.JL_API_ORIGIN ?? env.JITTLE_LAMP_API_ORIGIN;
  const token = env.JL_API_TOKEN ?? env.JL_AI_TOKEN;
  if (!origin) throw new Error("Set JL_API_ORIGIN to the Jittle Lamp API (for example https://api.jittlelamp.example).");
  if (!token) throw new Error("Set JL_API_TOKEN to an automation token or JL_AI_TOKEN to an AI token with MCP access.");
  return { client: new BackendClient({ origin, ...(fetchImpl ? { fetch: fetchImpl } : {}) }), token, log };
}

const environmentListSchema = z.union([z.array(testEnvironmentSchema), z.object({ items: z.array(testEnvironmentSchema) }).transform((value) => value.items)]);

async function findEnvironment(context: RemoteContext, nameOrId: string) {
  const environments = await context.client.request("GET", "/test-environments", context.token, environmentListSchema);
  const environment = environments.find((candidate) => candidate.id === nameOrId || candidate.name === nameOrId);
  if (!environment) throw new Error(`No environment "${nameOrId}". Known: ${environments.map((candidate) => candidate.name).join(", ") || "none"}`);
  return environment;
}

// jl-e2e env pull <env> [--with-secrets]: writes .env.e2e (mode 600). Without secrets the
// JL_CRED_* lines are empty placeholders to fill locally.
export async function envPull(context: RemoteContext, input: { environment: string; withSecrets: boolean; out: string }): Promise<string> {
  const environment = await findEnvironment(context, input.environment);
  const { content } = await context.client.request(
    "GET",
    `/test-environments/${encodeURIComponent(environment.id)}/env-file?withSecrets=${input.withSecrets}`,
    context.token,
    z.object({ content: z.string() })
  );
  writeFileSync(input.out, content.endsWith("\n") ? content : `${content}\n`, { mode: 0o600 });
  chmodSync(input.out, 0o600);
  const gitignore = resolve(input.out, "..", ".gitignore");
  if (input.withSecrets && (!existsSync(gitignore) || !/^\.env\.e2e/m.test(readFileSync(gitignore, "utf8")))) {
    context.log(`warning: ${input.out} holds secrets; make sure it is gitignored.`);
  }
  return input.out;
}

const slug = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "case";

// jl-e2e export --case <id|key>... <dir>: one transcript file per case.
export async function exportCases(context: RemoteContext, input: { ids: readonly string[]; dir: string }): Promise<string[]> {
  const { document } = await context.client.request(
    "GET",
    `/test-cases/export?ids=${input.ids.map(encodeURIComponent).join(",")}`,
    context.token,
    z.object({ document: z.string() })
  );
  mkdirSync(input.dir, { recursive: true });
  const written: string[] = [];
  for (const testCase of parseTranscriptDocument(document).cases) {
    const name = `${testCase.metadata.key ? `${testCase.metadata.key.toLowerCase()}-` : ""}${slug(testCase.title)}.transcript.md`;
    const path = join(input.dir, name);
    writeFileSync(path, `${serializeTestCase(testCase)}\n`);
    written.push(path);
  }
  return written;
}

// jl-e2e push <file>: creates or updates each case in the document, by Key, then by exact title.
export async function pushCases(context: RemoteContext, input: { file: string }): Promise<Array<{ title: string; id: string; action: "created" | "updated" }>> {
  const document = parseTranscriptDocument(readFileSync(input.file, "utf8"));
  if (document.diagnostics.length > 0) {
    throw new Error(document.diagnostics.map((diagnostic) => `line ${diagnostic.line}: ${diagnostic.message}`).join("\n"));
  }
  const results: Array<{ title: string; id: string; action: "created" | "updated" }> = [];
  for (const testCase of document.cases) {
    const transcript = serializeTestCase(testCase);
    const query = testCase.metadata.key ?? testCase.title;
    const list = await context.client.request("GET", `/test-cases?q=${encodeURIComponent(query)}&limit=50`, context.token, testCaseListResponseSchema);
    // A Key is authoritative: a document naming one never falls back to a title match.
    const existing =
      testCase.metadata.key !== null
        ? list.items.find((item) => item.key === testCase.metadata.key)
        : list.items.find((item) => item.title.trim() === testCase.title.trim());
    if (existing) {
      const updated = await context.client.request("PATCH", `/test-cases/${encodeURIComponent(existing.id)}`, context.token, testCaseDetailSchema, { transcript, expectedVersion: existing.transcriptVersion });
      results.push({ title: testCase.title, id: updated.id, action: "updated" });
    } else {
      const created = await context.client.request("POST", "/test-cases", context.token, testCaseDetailSchema, { transcript, source: "ai", status: "review" });
      results.push({ title: testCase.title, id: created.id, action: "created" });
    }
  }
  return results;
}

const finished = (run: TestRunDetail) => ["completed", "failed", "cancelled"].includes(run.status);

export async function waitForRuns(
  context: RemoteContext,
  runIds: readonly string[],
  options: { pollMs?: number; timeoutMs?: number; onUpdate?: (run: TestRunDetail) => void } = {}
): Promise<TestRunDetail[]> {
  const deadline = Date.now() + (options.timeoutMs ?? 60 * 60_000);
  const done = new Map<string, TestRunDetail>();
  while (done.size < runIds.length) {
    for (const runId of runIds) {
      if (done.has(runId)) continue;
      let run: TestRunDetail;
      try {
        run = await context.client.getRun(runId, context.token);
      } catch (error) {
        // One failed poll is not the end of the wait; the deadline is.
        context.log(`poll ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (finished(run)) {
        done.set(runId, run);
        options.onUpdate?.(run);
      }
    }
    if (done.size === runIds.length) break;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${runIds.length - done.size} run(s).`);
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 5_000));
  }
  return runIds.map((runId) => done.get(runId) as TestRunDetail);
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// JUnit for CI (design.md §12 phase 2 "JUnit export"; handover §6). Blocked runs are <skipped>
// with the reason, so pipelines do not count setup problems as test failures.
export function toJUnit(runs: readonly TestRunDetail[], suiteName: string, webOrigin?: string): string {
  const failed = (run: TestRunDetail) => run.outcome === "failed";
  // A run that never produced an outcome (RUNNER_LOST, a crashed runner) is an error, not a pass.
  const errored = (run: TestRunDetail) => run.outcome === null && run.status === "failed";
  const isSkipped = (run: TestRunDetail) => run.outcome === "blocked" || run.status === "cancelled";
  const failures = runs.filter(failed).length;
  const errors = runs.filter(errored).length;
  const skipped = runs.filter(isSkipped).length;
  const time = runs.reduce((sum, run) => sum + (run.metrics.durationMs ?? 0), 0) / 1000;
  const cases = runs.map((run) => {
    const seconds = ((run.metrics.durationMs ?? 0) / 1000).toFixed(3);
    const name = xml(`${run.testCaseKey} ${run.testCaseTitle}`);
    const link = run.evidenceId && webOrigin ? `${webOrigin.replace(/\/$/, "")}/evidence/${run.evidenceId}` : null;
    const failedStep = run.steps.find((step) => step.status === "failed" || step.status === "blocked");
    const detail = xml(
      [failedStep ? `step ${failedStep.ordinal} ${failedStep.label}: ${failedStep.error?.message ?? failedStep.observed ?? ""}` : run.error ?? "", link ? `evidence: ${link}` : ""]
        .filter(Boolean)
        .join("\n")
    );
    const props = `<properties><property name="runId" value="${xml(run.id)}"/><property name="costUsd" value="${run.metrics.costUsd ?? ""}"/><property name="stepsReplayed" value="${run.metrics.stepsReplayed}"/>${link ? `<property name="evidence" value="${xml(link)}"/>` : ""}</properties>`;
    const body = failed(run)
      ? `<failure message="${xml(failedStep?.error?.code ?? "FAILED")}">${detail}</failure>`
      : errored(run)
        ? `<error message="${xml(run.blockedReason ?? "RUN_FAILED")}">${detail || xml(run.error ?? "")}</error>`
        : isSkipped(run)
          ? `<skipped message="${xml(run.blockedReason ?? run.status)}">${detail}</skipped>`
          : "";
    return `    <testcase classname="${xml(suiteName)}" name="${name}" time="${seconds}">${props}${body}</testcase>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${runs.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time.toFixed(3)}">`,
    `  <testsuite name="${xml(suiteName)}" tests="${runs.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time.toFixed(3)}">`,
    ...cases,
    "  </testsuite>",
    "</testsuites>",
    ""
  ].join("\n");
}

// jl-e2e run --suite <id> | --case <id> [--env <id>] [--wait] [--junit out.xml]
export async function runRemote(
  context: RemoteContext,
  input: { suiteId?: string; caseId?: string; environmentId?: string; params?: Record<string, string>; force?: boolean; wait: boolean; junit?: string; webOrigin?: string; cacheMode?: "read-write" | "read-only" | "off" | "strict"; pollMs?: number; failOnBlocked?: boolean }
): Promise<{ runIds: string[]; runs: TestRunDetail[]; exitCode: number }> {
  const body = {
    ...(input.environmentId ? { environmentId: input.environmentId } : {}),
    params: input.params ?? {},
    force: input.force ?? false,
    trigger: "ci" as const,
    ...(input.cacheMode ? { cacheMode: input.cacheMode } : {})
  };
  const created = input.suiteId
    ? await context.client.createSuiteRun(input.suiteId, context.token, body)
    : await context.client.createRun(input.caseId ?? "", context.token, body);
  const runIds = created.runIds.length > 0 ? created.runIds : [created.runId];
  context.log(`${runIds.length} run(s) ${created.attached ? "attached" : "queued"}${created.batchId ? ` in batch ${created.batchId}` : ""}`);
  if (!input.wait) return { runIds, runs: [], exitCode: 0 };
  const runs = await waitForRuns(context, runIds, {
    ...(input.pollMs ? { pollMs: input.pollMs } : {}),
    onUpdate: (run) => context.log(`${run.outcome ?? run.status} ${run.testCaseKey} ${run.testCaseTitle}`)
  });
  if (input.junit) writeFileSync(input.junit, toJUnit(runs, input.suiteId ? `suite ${input.suiteId}` : `case ${input.caseId}`, input.webOrigin));
  // Failed cases and runs without an outcome fail the job; blocked cases don't (ADR 0002 decision 6)
  // unless --fail-on-blocked.
  const blocked = runs.filter((run) => run.outcome === "blocked" || run.status === "cancelled");
  if (blocked.length > 0) context.log(`${blocked.length} run(s) blocked: ${blocked.map((run) => `${run.testCaseKey} ${run.blockedReason ?? run.status}`).join(", ")}`);
  const exitCode = runs.some((run) => run.outcome === "failed" || (run.outcome === null && run.status === "failed"))
    ? 1
    : input.failOnBlocked && blocked.length > 0
      ? 3
      : 0;
  return { runIds, runs, exitCode };
}

// Instructions are explored on the environment runner, then a person reviews the batch.
export async function generateCases(context: RemoteContext, input: { content: string; environmentId: string; queueWithoutRunner?: boolean }) {
  return context.client.request("POST", "/test-cases/import", context.token, importBatchSchema,
    createImportRequestSchema.parse({ sourceKind: "instructions", content: input.content, environmentId: input.environmentId, queueWithoutRunner: input.queueWithoutRunner }));
}

export async function getImportBatch(context: RemoteContext, batchId: string) {
  return context.client.request("GET", `/test-cases/import/${encodeURIComponent(batchId)}`, context.token, importBatchSchema);
}

export async function submitImportBatch(context: RemoteContext, batchId: string) {
  return context.client.request("PATCH", `/test-cases/import/${encodeURIComponent(batchId)}`, context.token, importBatchSchema, { commit: true });
}
