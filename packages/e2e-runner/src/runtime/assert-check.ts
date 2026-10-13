import type { Locator } from "e2e";
import { z } from "zod/v4";

import { createJlCheckStore, type AssertCheck, type AssertCheckLocator, type CheckStore } from "./cache-store";

// Deterministic assert cache (roadmap 2026-10-13 §4.1). An Assert normally costs one judge call
// per run. After a judged assert passes on a recording run, the act model is asked once which
// single on-screen control proves it; the answer is validated against the live screen (exactly
// one match, matcher holds now) and stored as the step's check. Later runs run the matcher
// instead of the judge: zero model calls. A check that no longer holds goes stale and the judge
// takes the step over, or under `strict` the step fails with REPLAY_STALE like a stale act.
// This module runs inside the e2e worker: no @jittle-lamp/shared imports.

export type CacheModeName = "read-write" | "read-only" | "off" | "strict";

type LocatorExpectation = {
  toBeVisible(options?: { timeout?: number }): Promise<void>;
  toContainText(expected: string, options?: { timeout?: number }): Promise<void>;
};
type BrowserExpectation = { toHaveURL(expected: string | RegExp, options?: { timeout?: number }): Promise<void> };

type ScreenQueries = {
  getByRole(role: never, name: string): Locator;
  getByLabel(text: string): Locator;
  getByText(text: string): Locator;
  getByTestId(id: string): Locator;
};

export type AssertCheckFixtures = {
  agent: { extract(instruction: string, options: { schema: unknown }): Promise<unknown> };
  screen: ScreenQueries;
  // e2e's `expect`: a locator or the browser fixture; typed loosely so the overloads need no mirror.
  expect: (actual: unknown) => unknown;
  // The web engine's `browser` fixture, for the `url` matcher.
  browser?: unknown;
};

export type CheckOutcome = { status: "hit" | "stale" | "recorded"; locator: string; reason?: string };

export type AssertWithCheckResult = { summary: string | null; check: CheckOutcome | null };

export type AssertWithCheckOptions = {
  // Judges the assert text; the caller wraps agent.assert in its settle logic.
  judge: (text: string) => Promise<unknown>;
  instructionKey?: string | null;
  store?: CheckStore;
  cacheMode?: CacheModeName;
  // Replay budget for the matcher; the judge waits as long as the step allows.
  replayTimeoutMs?: number;
};

export const defaultReplayTimeoutMs = 5000;
const validateTimeoutMs = 2000;

// The model's answer: one control or `none`. Nullable rather than optional fields, which strict
// structured-output providers need.
export const checkAnswerSchema = z.object({
  kind: z.enum(["role", "label", "text", "testId", "none"]).describe("how the control is found; none when no single control proves the statement"),
  role: z.string().nullable().describe("ARIA role when kind is role (button, heading, textbox, link, ...)"),
  name: z.string().nullable().describe("the control's accessible name when kind is role"),
  value: z.string().nullable().describe("the label, visible text or test id when kind is label, text or testId"),
  matcher: z.enum(["visible", "text", "url"]).describe("visible: the control is shown; text: it contains `expected`; url: the page URL contains `expected`"),
  expected: z.string().nullable().describe("the text or URL for the text and url matchers; null for visible")
});
export type CheckAnswer = z.infer<typeof checkAnswerSchema>;

export function extractInstruction(text: string): string {
  return `the single on-screen control that proves: ${text}. Answer kind none when no single control proves it (a count, a layout, a judgement call).`;
}

const q = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

export function renderLocator(locator: AssertCheckLocator): string {
  if ("role" in locator) return `screen.getByRole(${q(locator.role)}, ${q(locator.name)})`;
  if ("label" in locator) return `screen.getByLabel(${q(locator.label)})`;
  if ("text" in locator) return `screen.getByText(${q(locator.text)})`;
  return `screen.getByTestId(${q(locator.testId)})`;
}

// The e2e call the check runs, as the Scripts drawer shows it.
export function renderCheck(check: AssertCheck): string {
  if (check.matcher === "url") return `expect(browser).toHaveURL(${q(check.expected ?? "")})`;
  const target = check.locator ? renderLocator(check.locator) : "screen";
  if (check.matcher === "text") return `expect(${target}).toContainText(${q(check.expected ?? "")})`;
  return `expect(${target}).toBeVisible()`;
}

export function locatorFromAnswer(answer: CheckAnswer): AssertCheckLocator | null {
  switch (answer.kind) {
    case "role":
      return answer.role && answer.name ? { role: answer.role, name: answer.name } : null;
    case "label":
      return answer.value ? { label: answer.value } : null;
    case "text":
      return answer.value ? { text: answer.value } : null;
    case "testId":
      return answer.value ? { testId: answer.value } : null;
    case "none":
      return null;
  }
}

// The check an answer describes, or null when the answer proves nothing deterministic.
export function checkFromAnswer(answer: CheckAnswer, now = new Date()): AssertCheck | null {
  const locator = locatorFromAnswer(answer);
  // A url matcher needs no control but needs the URL.
  if (answer.matcher === "url") return answer.expected ? { schemaVersion: "jl-assert-check-1", locator, matcher: "url", expected: answer.expected, recordedAt: now.toISOString() } : null;
  // The other matchers need the control.
  if (!locator) return null;
  // The text matcher needs the text.
  if (answer.matcher === "text" && !answer.expected) return null;
  return {
    schemaVersion: "jl-assert-check-1",
    locator,
    matcher: answer.matcher,
    expected: answer.matcher === "text" ? answer.expected : null,
    recordedAt: now.toISOString()
  };
}

export function buildLocator(screen: ScreenQueries, locator: AssertCheckLocator): Locator {
  if ("role" in locator) return screen.getByRole(locator.role as never, locator.name);
  if ("label" in locator) return screen.getByLabel(locator.label);
  if ("text" in locator) return screen.getByText(locator.text);
  return screen.getByTestId(locator.testId);
}

export async function runCheck(check: AssertCheck, fixtures: AssertCheckFixtures, timeoutMs: number): Promise<void> {
  if (check.matcher === "url") {
    // The url matcher needs the browser fixture; a target without one cannot replay it.
    if (!fixtures.browser) throw new Error("no browser fixture for the url matcher");
    await (fixtures.expect(fixtures.browser) as BrowserExpectation).toHaveURL(check.expected ?? "", { timeout: timeoutMs });
    return;
  }
  // visible and text need the control.
  if (!check.locator) throw new Error("the check names no control");
  const expectation = fixtures.expect(buildLocator(fixtures.screen, check.locator)) as LocatorExpectation;
  if (check.matcher === "text") {
    await expectation.toContainText(check.expected ?? "", { timeout: timeoutMs });
    return;
  }
  await expectation.toBeVisible({ timeout: timeoutMs });
}

// A check is stored only when its locator matches exactly one node and its matcher holds now.
export async function validateCheck(check: AssertCheck, fixtures: AssertCheckFixtures): Promise<boolean> {
  try {
    if (check.locator) {
      const count = await buildLocator(fixtures.screen, check.locator).count();
      // Zero or several matches would make the replay ambiguous or a false negative.
      if (count !== 1) return false;
    }
    await runCheck(check, fixtures, validateTimeoutMs);
    return true;
  } catch {
    return false;
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";

// One extract call per assert per recording run, whatever the answer.
const extractAttempted = new Set<string>();

export function resetExtractBudget(): void {
  extractAttempted.clear();
}

export async function askForCheck(text: string, fixtures: AssertCheckFixtures): Promise<AssertCheck | null> {
  let answer: CheckAnswer;
  try {
    const raw = await fixtures.agent.extract(extractInstruction(text), { schema: checkAnswerSchema });
    const parsed = checkAnswerSchema.safeParse(raw);
    // An answer outside the grammar proves nothing; the judge's verdict already stands.
    if (!parsed.success) return null;
    answer = parsed.data;
  } catch {
    // The model could not name a control (inconclusive, provider failure): no check this run.
    return null;
  }
  return checkFromAnswer(answer);
}

export async function assertWithCheck(stepId: string, text: string, fixtures: AssertCheckFixtures, options: AssertWithCheckOptions): Promise<AssertWithCheckResult> {
  const mode = options.cacheMode ?? (process.env.JL_CACHE_MODE as CacheModeName | undefined) ?? "read-write";
  const judge = async (): Promise<AssertWithCheckResult> => {
    const verdict = (await options.judge(text)) as { summary?: unknown } | undefined;
    return { summary: verdict && typeof verdict.summary === "string" ? verdict.summary : null, check: null };
  };
  // With the cache off the step is judged, nothing read, nothing written.
  if (mode === "off") return judge();
  const store = options.store ?? createJlCheckStore({ writable: mode === "read-write" });
  const timeoutMs = options.replayTimeoutMs ?? defaultReplayTimeoutMs;

  const existing = await store.read(stepId).catch(() => null);
  if (existing) {
    const rendered = renderCheck(existing);
    try {
      await runCheck(existing, fixtures, timeoutMs);
      return { summary: `replayed ${rendered}`, check: { status: "hit", locator: rendered } };
    } catch (error) {
      const reason = message(error);
      await store.stale(stepId, reason).catch(() => undefined);
      // Strict hands no step to the judge: the step fails like a stale act under cache.strict.
      if (mode === "strict") {
        throw Object.assign(new Error(`the check of this step no longer holds (${rendered}: ${reason}), and cache.strict hands no step to the agent`), {
          code: "REPLAY_STALE",
          blocked: true
        });
      }
      const judged = await judge();
      return { ...judged, check: { status: "stale", locator: rendered, reason } };
    }
  }

  const judged = await judge();
  // Only a recording run asks for a check; read-only and strict never write.
  if (mode !== "read-write" || !store.writable) return judged;
  // One model question per assert per run, whatever it answered.
  if (extractAttempted.has(stepId)) return judged;
  extractAttempted.add(stepId);
  const check = await askForCheck(text, fixtures);
  // `none`, or an answer that proves nothing deterministic.
  if (!check) return judged;
  // An answer the live screen does not confirm is not stored.
  if (!(await validateCheck(check, fixtures))) return judged;
  const rendered = renderCheck(check);
  await store.write(stepId, check, { instructionKey: options.instructionKey ?? null, renderedCode: rendered }).catch(() => undefined);
  return { ...judged, check: { status: "recorded", locator: rendered } };
}
