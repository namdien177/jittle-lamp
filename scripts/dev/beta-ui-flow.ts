// Beta DoD item 1 (docs/e2e-test-cases/handover.md §6) through the real web UI: a QA engineer
// creates a case with the structured step editor, tags it, runs it on the cloud pool, watches the
// steps live, reviews the finished run with step seek, re-runs it and sees replayed steps.
//
// Prerequisites (local dev-auth stack only, never the root .env):
//   1. `.env.dev-auth` in the repo root from `bun run dev:test-auth:setup`, with your own ports, e.g.
//      PORT=3101, JITTLE_LAMP_API_ORIGIN=http://127.0.0.1:3101, JITTLE_LAMP_WEB_ORIGIN /
//      WEB_APP_ORIGIN / CLERK_AUTHORIZED_PARTIES=http://127.0.0.1:4273, DATABASE_URL=file:./local.dev-auth.db,
//      and JL_SECRETS_MASTER_KEY set (credential secrets are encrypted at rest).
//   2. Packages and the web app built against that env:
//      bun run build:shared && bun run build:ui && bun run build:viewer-core && bun run build:viewer-react
//      set -a; source .env.dev-auth; set +a; bun --no-env-file run --cwd apps/evidence-web build
//   3. Chromium for Playwright (`bunx playwright install chromium`).
//
// The script starts what is not running: the backend on PORT (with the dev-auth env), a static
// server for apps/evidence-web/dist on the web origin's port, the fixture app, and the runner
// daemon (`packages/e2e-runner/src/daemon.ts start --once`) whenever a run is queued. It stops
// everything it started. Setup data (organisation, environment, credential, model settings) goes
// through the API with the dev-auth token; the case, tags and runs go through the UI.
//
// The model is the runner's `mock:` provider replaying packages/e2e-runner/test/fixtures/
// fixture-logout.mock.json, copied to a temp file with two act turns delayed by 4 s so the live
// progress is visible. No model key, no secret: the credential is the fixture app's test password.
//
// Usage: bun scripts/dev/beta-ui-flow.ts [--out docs/e2e-test-cases/evidence] [--headed]
// BETA_FLOW_DEBUG=1 also logs the run steps the API returns mid-run.
// Exit code 0 when every assertion holds, 1 otherwise.

import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

import { chromium, type Page } from "playwright";

import { startFixtureApp } from "../../packages/e2e-runner/test/fixtures/app/server";

const root = resolve(import.meta.dir, "../..");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = resolve(root, outIndex !== -1 && args[outIndex + 1] ? (args[outIndex + 1] as string) : "docs/e2e-test-cases/evidence");
const headed = args.includes("--headed");

const envPath = join(root, ".env.dev-auth");
if (!existsSync(envPath)) fail("Missing .env.dev-auth; run `bun run dev:test-auth:setup` first (see the header).");
const devEnv = Object.fromEntries(Object.entries(parseEnv(readFileSync(envPath, "utf8"))).filter((entry): entry is [string, string] => entry[1] !== undefined));
const apiOrigin = (devEnv.JITTLE_LAMP_API_ORIGIN ?? "http://127.0.0.1:3101").replace(/\/+$/, "");
const webOrigin = (devEnv.JITTLE_LAMP_WEB_ORIGIN ?? "http://127.0.0.1:4273").replace(/\/+$/, "");
const devToken = devEnv.JITTLE_LAMP_DEV_AUTH_TOKEN ?? "";
if (!devToken) fail("JITTLE_LAMP_DEV_AUTH_TOKEN missing in .env.dev-auth.");
const webDist = join(root, "apps/evidence-web/dist");
if (!existsSync(join(webDist, "index.html"))) fail("apps/evidence-web/dist is missing; build the web app first (see the header).");

const FIXTURE_EMAIL = "admin@example.test";
const FIXTURE_PASSWORD = "fixture-Pa55word!"; // the fixture app's test password, also in the repo's runner tests
const TITLE = "Admin logout returns a clean login form";

const started: Array<{ name: string; stop: () => void; output?: string[] }> = [];
const log = (message: string) => console.log(`[beta-ui-flow] ${message}`);

function fail(message: string): never {
  console.error(`[beta-ui-flow] FAIL: ${message}`);
  throw new FlowError(message);
}
class FlowError extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
  log(`ok: ${message}`);
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, {
    method,
    headers: { authorization: `Bearer ${devToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  if (!response.ok) fail(`${method} ${path} → ${response.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function waitUntil(label: string, probe: () => Promise<boolean>, timeoutMs = 60_000, intervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await Bun.sleep(intervalMs);
  }
  fail(`timed out waiting for ${label}`);
}

function spawnTracked(name: string, command: string[], env: Record<string, string | undefined>): ChildProcess {
  const child = spawn(command[0] as string, command.slice(1), { cwd: root, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  child.stdout?.on("data", (chunk) => lines.push(String(chunk)));
  child.stderr?.on("data", (chunk) => lines.push(String(chunk)));
  started.push({ name, stop: () => child.exitCode === null && child.kill("SIGTERM"), output: lines });
  return child;
}

async function startStack(): Promise<void> {
  if (await reachable(`${apiOrigin}/health`)) log(`backend already running on ${apiOrigin}`);
  else {
    log(`starting backend on ${apiOrigin}`);
    spawnTracked("backend", ["bun", "--no-env-file", "run", "--cwd", "apps/backend", "src/index.ts"], { PATH: process.env.PATH, HOME: process.env.HOME, ...devEnv });
    await waitUntil("backend /health", () => reachable(`${apiOrigin}/health`), 60_000);
  }
  if (await reachable(webOrigin)) log(`web already served on ${webOrigin}`);
  else {
    const port = Number(new URL(webOrigin).port || 80);
    log(`serving ${webDist} on ${webOrigin}`);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(request) {
        const path = decodeURIComponent(new URL(request.url).pathname);
        if (path !== "/" && !path.includes("..")) {
          const file = Bun.file(join(webDist, path));
          if (await file.exists()) return new Response(file);
        }
        return new Response(Bun.file(join(webDist, "index.html")), { headers: { "content-type": "text/html" } });
      }
    });
    started.push({ name: "web", stop: () => server.stop(true) });
  }
}

type Seed = { orgId: string; environmentId: string; registrationToken: string; fixtureUrl: string };

async function seed(): Promise<Seed> {
  const app = startFixtureApp({ email: FIXTURE_EMAIL, password: FIXTURE_PASSWORD });
  started.push({ name: "fixture app", stop: app.stop });
  log(`fixture app on ${app.url}`);

  const { organization } = await api<{ organization: { id: string } }>("POST", "/orgs", { name: `Beta flow ${new Date().toISOString().slice(0, 16)}` });
  await api("POST", `/orgs/${organization.id}/select-active`);

  const environment = await api<any>("POST", "/test-environments", {
    name: "fixture",
    baseUrl: app.url,
    variables: {},
    runnerPool: "cloud",
    agentInstructions: "Fixture app for the beta UI flow. Never delete records."
  });
  await api("POST", "/test-credentials", {
    profile: "ADMIN",
    environmentId: (environment.environment ?? environment).id,
    fields: { username: FIXTURE_EMAIL },
    secretFields: { password: FIXTURE_PASSWORD }
  });

  // Slow mock: two act turns wait 4 s so the run page shows steps done and one running.
  const mockDir = mkdtempSync(join(tmpdir(), "jl-beta-flow-"));
  const mockPath = join(mockDir, "fixture-logout.slow.mock.json");
  copyFileSync(join(root, "packages/e2e-runner/test/fixtures/fixture-logout.mock.json"), mockPath);
  const mock = JSON.parse(readFileSync(mockPath, "utf8")) as { turns: Array<{ match: { tools?: string[]; promptIncludes?: string[] }; delayMs?: number }> };
  const slow = mock.turns.filter((turn) => turn.match.tools?.includes("tap") && (turn.match.promptIncludes?.[0] === "submit the login form" || turn.match.promptIncludes?.[0] === "open the account menu"));
  for (const turn of slow.slice(0, 2)) turn.delayMs = 4000;
  check(slow.length >= 2, "slow mock has two delayed act turns");
  writeFileSync(mockPath, JSON.stringify(mock, null, 2));
  await api("PUT", "/test-model-settings", { actModel: `mock:${mockPath}`, judgeModel: `mock:${mockPath}` });

  const pools = await api<{ items?: any[] } | any[]>("GET", "/runner-pools");
  const list = Array.isArray(pools) ? pools : (pools.items ?? []);
  const cloud = list.find((pool: any) => pool.kind === "cloud");
  check(cloud, "the organisation has a cloud runner pool");
  const { registrationToken } = await api<{ registrationToken: string }>("POST", `/runner-pools/${cloud.id}/registration-token`);
  return { orgId: organization.id, environmentId: (environment.environment ?? environment).id, registrationToken, fixtureUrl: app.url };
}

function startRunner(seeded: Seed, statePath: string, workDir: string): ChildProcess {
  log("starting jl-e2e-runner (--once) on the cloud pool");
  return spawnTracked("runner", ["bun", "packages/e2e-runner/src/daemon.ts", "start", "--api", apiOrigin, "--token", seeded.registrationToken, "--once", "--state", statePath, "--work-dir", workDir], {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH
  });
}

async function shot(page: Page, name: string): Promise<void> {
  const path = join(outDir, `dod1-${name}.png`);
  await page.screenshot({ path });
  log(`screenshot ${path}`);
}

// The steps part of the fixture transcript (everything after the metadata block).
function fixtureSteps(): string {
  const transcript = readFileSync(join(root, "packages/e2e-runner/test/fixtures/fixture-logout.transcript.md"), "utf8");
  return transcript.split(/\n\s*\n/).slice(1).join("\n\n").trim();
}

async function pasteInto(page: Page, selector: string, text: string): Promise<void> {
  await page.locator(selector).first().focus();
  await page.evaluate(
    ({ selector: target, text: value }) => {
      const element = document.querySelector(target);
      if (!element) throw new Error(`no ${target}`);
      const data = new DataTransfer();
      data.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { selector, text }
  );
}

async function runDetail(runId: string): Promise<any> {
  const payload = await api<any>("GET", `/test-runs/${runId}`);
  return payload.run ?? payload;
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  await startStack();
  const seeded = await seed();
  const runnerState = join(mkdtempSync(join(tmpdir(), "jl-beta-runner-")), "state.json");
  const runnerWork = mkdtempSync(join(tmpdir(), "jl-beta-work-"));

  const browser = await chromium.launch({ headless: !headed });
  started.push({ name: "browser", stop: () => void browser.close() });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // 1. Create the case with the structured editor (quick create `c`), steps pasted into one row.
  await page.goto(`${webOrigin}/test-cases`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: /Test cases/ }).waitFor();
  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "New test case" });
  await dialog.waitFor();
  await dialog.getByLabel("Title", { exact: true }).fill(TITLE);
  await pasteInto(page, "[role=dialog] .jl-se-input", fixtureSteps());
  await page.waitForTimeout(300);
  const rowCount = await dialog.locator(".jl-se-row[data-kind=step]").count();
  const headingCount = await dialog.locator(".jl-se-row[data-kind=heading]").count();
  check(rowCount === 6 && headingCount === 1, `paste split into 6 step rows and 1 checkpoint (got ${rowCount} + ${headingCount})`);
  await shot(page, "1-editor-pasted");

  // 2. Tag it through the metadata form and pick the environment.
  const tagInput = dialog.getByLabel("Add tag");
  for (const tag of ["team:qa-pcf", "feature:login"]) {
    await tagInput.fill(tag);
    await tagInput.press("Enter");
  }
  await dialog.getByLabel("Environment", { exact: true }).selectOption("fixture");
  check((await dialog.getByRole("button", { name: "Remove tag team:qa-pcf" }).count()) === 1, "tag team:qa-pcf is on the case");
  await dialog.getByRole("tab", { name: "Text" }).click();
  const documentText = await dialog.getByLabel("Transcript document").inputValue();
  check(documentText.includes("Tags: team:qa-pcf, feature:login") && documentText.includes("Env: fixture"), "Text view shows the tags and environment lines");
  await dialog.getByRole("tab", { name: "Steps" }).click();
  await shot(page, "2-tags");
  await dialog.getByRole("button", { name: "Create case" }).click();
  await page.waitForURL(/[?&]case=/, { timeout: 15_000 });
  const caseId = new URL(page.url()).searchParams.get("case") ?? "";
  const created = await api<any>("GET", `/test-cases/${caseId}`);
  const detail = created.testCase ?? created;
  check(detail.tags.includes("team:qa-pcf") && detail.steps.length === 6, "the created case has the tag and 6 steps");
  check(detail.environmentId === seeded.environmentId, "the created case uses the fixture environment");

  // 3. Run it on the cloud pool from the Run dialog.
  const pane = page.locator("[data-pane=detail]");
  await pane.getByRole("button", { name: /^Run/ }).click();
  const runDialog = page.getByRole("dialog", { name: /^Run TC-/ });
  await runDialog.waitFor();
  check((await runDialog.getByText("fixture · cloud").count()) > 0, "the Run dialog targets the fixture environment on the cloud pool");
  await runDialog.getByRole("button", { name: "Run", exact: true }).click();
  await runDialog.getByRole("status").waitFor();
  check((await runDialog.getByText(/^Queued/).count()) === 1 && (await runDialog.getByText("#1 of 1", { exact: false }).count()) === 1, "the run request was queued as #1 of 1 (not attached)");
  await shot(page, "3-run-dialog");
  const runner1 = startRunner(seeded, runnerState, runnerWork);
  await runDialog.getByRole("button", { name: "Open run" }).click();
  await page.waitForURL(/\/test-runs\//);
  const run1Id = page.url().split("/test-runs/")[1]?.split(/[?#]/)[0] ?? "";

  // 4. Watch live progress: some steps done, one running.
  await page.waitForFunction(
    () => document.querySelectorAll(".jl-run-step[data-status=passed]").length >= 2 && document.querySelector(".jl-run-step[data-status=running]") !== null,
    undefined,
    { timeout: 90_000, polling: 250 }
  );
  check(true, "run page shows passed steps and a running step while the run executes");
  const unnamed = await page.$$eval(".jl-run-step-label", (labels) =>
    labels
      .map((label) => {
        const type = label.querySelector(".jl-run-step-type")?.textContent ?? "";
        const mode = label.querySelector(".jl-run-step-mode")?.textContent ?? "";
        return { all: (label.textContent ?? "").trim(), instruction: (label.textContent ?? "").replace(type, "").replace(mode, "").trim() };
      })
      .filter((entry) => entry.instruction.length === 0)
      .map((entry) => entry.all)
  );
  check(unnamed.length === 0, `every live step row has its instruction${unnamed.length ? ` (unnamed: ${unnamed.join(" | ")})` : ""}`);
  await shot(page, "4-live-progress");
  if (process.env.BETA_FLOW_DEBUG) {
    const live = await runDetail(run1Id);
    log(`live steps: ${JSON.stringify(live.steps.map((step: any) => [step.stepId, step.parentStepId, step.ordinal, step.type, step.label, step.status]))}`);
  }

  // 5. Finished run: click a step, the viewer filters the timeline and seeks the video.
  await waitUntil("run 1 to finish", async () => ["completed", "failed", "cancelled"].includes((await runDetail(run1Id)).status), 180_000, 1000);
  await waitUntil("runner 1 to exit", async () => runner1.exitCode !== null, 30_000);
  const run1 = await runDetail(run1Id);
  check(run1.outcome === "passed", `run 1 passed (outcome ${run1.outcome}, ${run1.blockedReason ?? ""} ${run1.error ?? ""})`);
  check(run1.evidenceId, "run 1 uploaded evidence");
  await page.locator(".jl-vm-root video").first().waitFor({ timeout: 30_000 });
  const target = run1.steps.find((step: any) => step.parentStepId === null && step.type === "act");
  check(target && target.videoOffsetMs !== null && target.videoOffsetMs > 0, "the act step has a video offset");
  await page.locator(`.jl-run-step[data-step-id="${target.stepId}"]`).click();
  await page.waitForFunction(
    (offset) => {
      const video = document.querySelector(".jl-vm-root video") as HTMLVideoElement | null;
      return video !== null && Math.abs(video.currentTime * 1000 - offset) < 1500;
    },
    target.videoOffsetMs,
    { timeout: 15_000 }
  );
  check(true, `selecting the step seeked the video to ~${Math.round(target.videoOffsetMs)} ms`);
  const activeChip = await page.locator(".jl-vm-root [aria-pressed=true], .jl-vm-root [data-active=true]").count();
  check(activeChip > 0, "the viewer marks the selected step in its step filter");
  await page.waitForTimeout(600);
  await shot(page, "5-finished-step-seek");

  // 6. Re-run (force) from the UI and see replayed steps with zero act model calls.
  await page.goto(`${webOrigin}/test-cases?case=${caseId}`, { waitUntil: "networkidle" });
  await page.locator("[data-pane=detail]").getByRole("button", { name: /^Run/ }).click();
  const rerunDialog = page.getByRole("dialog", { name: /^Run TC-/ });
  await rerunDialog.getByLabel(/Run again even if/).check();
  await rerunDialog.getByRole("button", { name: "Run", exact: true }).click();
  await rerunDialog.getByRole("status").waitFor();
  const runner2 = startRunner(seeded, runnerState, runnerWork);
  await rerunDialog.getByRole("button", { name: "Open run" }).click();
  await page.waitForURL(/\/test-runs\//);
  const run2Id = page.url().split("/test-runs/")[1]?.split(/[?#]/)[0] ?? "";
  check(run2Id !== run1Id, "the forced re-run is a new run");
  await waitUntil("run 2 to finish", async () => ["completed", "failed", "cancelled"].includes((await runDetail(run2Id)).status), 180_000, 1000);
  await waitUntil("runner 2 to exit", async () => runner2.exitCode !== null, 30_000);
  const run2 = await runDetail(run2Id);
  check(run2.outcome === "passed", "run 2 passed");
  const acts = run2.steps.filter((step: any) => step.type === "act");
  const replayedActs = acts.filter((step: any) => step.mode === "replayed" && step.usage.modelCalls === 0);
  check(replayedActs.length >= 4 && replayedActs.length === acts.length, `run 2 replayed all ${acts.length} act steps with 0 model calls (${replayedActs.length} replayed)`);
  check(run2.metrics.stepsReplayed >= 4, `run 2 metrics count ${run2.metrics.stepsReplayed} replayed steps`);
  await page.getByText("passed", { exact: true }).first().waitFor({ timeout: 15_000 });
  const toggle = page.getByLabel("Show macro steps");
  if (await toggle.count()) await toggle.check();
  await page.waitForTimeout(400);
  const replayedChips = await page.locator(".jl-run-step-mode[data-mode=replayed]").count();
  check(replayedChips >= 4, `run page shows ${replayedChips} "replayed" mode chips`);
  await page.locator(".jl-run-steps").scrollIntoViewIfNeeded();
  await shot(page, "6-rerun-replayed");

  check(pageErrors.length === 0, `no uncaught page errors${pageErrors.length ? `: ${pageErrors.join(" | ")}` : ""}`);
  log("all checks passed");
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  if (!(error instanceof FlowError)) console.error(error);
  for (const entry of started.filter((candidate) => candidate.name === "runner")) {
    console.error(`[beta-ui-flow] runner output:\n${(entry.output ?? []).join("").slice(-4000)}`);
  }
} finally {
  for (const entry of started.reverse()) {
    try {
      entry.stop();
    } catch {
      // already stopped
    }
  }
}
process.exit(exitCode);
