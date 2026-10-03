import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { credentials, secrets, unique } from "e2e";

import { currentPage } from "./engine";
import { markSecretUsed, waitWhileTakenOver } from "./live";
import { writeStepLog } from "./step-log";

// Imported by the generated case.e2e.ts. Values are read from the JL_* environment at run time,
// so the generated file holds names only (ADR 0002 decision 9).

export type StepMeta = {
  stepId: string;
  parentStepId: string | null;
  ordinal: number;
  kind: string;
  label: string;
};

export type Binding =
  | { kind: "var"; name: string }
  | { kind: "cred"; profile: string; field: string }
  | { kind: "cred-password"; profile: string }
  | { kind: "secret"; name: string }
  | { kind: "extracted"; name: string };

const extracted = new Map<string, string>();

function envVar(name: string): string {
  const value = process.env[`JL_VAR_${name}`];
  if (value === undefined) throw Object.assign(new Error(`vars.${name} is not set`), { code: "MISSING_VARIABLE", blocked: true });
  return value;
}

function credentialField(profile: string, field: string): string {
  const value = process.env[`JL_CRED_${profile}_${field.toUpperCase()}`];
  if (value === undefined) {
    throw Object.assign(new Error(`credential('${profile}').${field} is not set`), { code: "MISSING_CREDENTIAL", blocked: true });
  }
  return value;
}

export function params(bindings: Readonly<Record<string, Binding>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [param, binding] of Object.entries(bindings)) {
    switch (binding.kind) {
      case "var":
        out[param] = unique(envVar(binding.name));
        break;
      case "cred":
        out[param] = unique(credentialField(binding.profile, binding.field));
        break;
            case "cred-password":
        markSecretUsed();
        out[param] = credentials.user(binding.profile).password;
        break;
      case "secret":
        markSecretUsed();
        out[param] = secrets.get(binding.name);
        break;
      case "extracted": {
        const value = extracted.get(binding.name) ?? "";
        // unique() refuses an empty value; an empty one cannot leak into the key anyway.
        out[param] = value.length > 0 ? unique(value) : value;
        break;
      }
    }
  }
  return out;
}

// Text for steps that take no params (open, assert, wait, extract): public values substituted,
// secrets left as their name so they never reach the judge.
export function fill(template: string, bindings: Readonly<Record<string, Binding>>): string {
  return template.replace(/\{([^{}\s]+)\}/g, (match, name: string) => {
    const binding = bindings[name];
    if (!binding) return match;
    switch (binding.kind) {
      case "var":
        return envVar(binding.name);
      case "cred":
        return credentialField(binding.profile, binding.field);
      case "extracted":
        return extracted.get(binding.name) ?? "";
      default:
        return `<secret:${name}>`;
    }
  });
}

export function setExtracted(name: string, value: unknown): void {
  extracted.set(name, typeof value === "string" ? value : JSON.stringify(value));
}

export const stringSchema = {
  "~standard": {
    version: 1,
    vendor: "jittle-lamp",
    validate: (value: unknown) =>
      typeof value === "string" || typeof value === "number"
        ? { value: String(value) }
        : { issues: [{ message: "expected a text value" }] }
  }
} as const;

// Outcomes that say nothing about the app under test: blocked, never failed (ADR 0002 decision 6;
// design.md §5.1 "inconclusive → blocked").
const blockingCodes = new Set([
  "ASSERTION_INCONCLUSIVE",
  "MODEL_PROVIDER_FAILED",
  "MODEL_OUTPUT_INVALID",
  "MODEL_UNAVAILABLE",
  "STEP_NO_CONCLUSION",
  "STEP_BUDGET_EXHAUSTED",
  "CONTEXT_OVERFLOW",
  "MISSING_VARIABLE",
  "MISSING_CREDENTIAL",
  // e2e's setup and environment codes (the app or its data, not the behaviour under test)
  "APP_UNREACHABLE",
  "APP_NOT_OPEN",
  "ENVIRONMENT_UNAVAILABLE",
  "AUTH_CREDENTIAL_UNAVAILABLE",
  "AUTH_CREDENTIAL_INVALID",
  "SECRET_UNAVAILABLE",
  "SEED_DATA_MISSING",
  "TEST_SETUP_FAILED",
  "POLICY_DENIED",
  "AUTOMATION_UNSUPPORTED",
  "STEP_TIMEOUT"
]);

function errorInfo(error: unknown): { code: string; message: string; blocked: boolean; observed: string | null } {
  const record = (error ?? {}) as { code?: unknown; message?: unknown; blocked?: unknown; explanation?: unknown };
  const code = typeof record.code === "string" ? record.code : "STEP_FAILED";
  const message = typeof record.message === "string" ? record.message : String(error);
  const explanation = typeof record.explanation === "string" ? record.explanation : null;
  return { code, message, blocked: record.blocked === true || blockingCodes.has(code), observed: explanation };
}

// A reduced screenshot per finished step for live progress (design.md §5.4); people see it, the
// model never does.
async function progressScreenshot(stepId: string): Promise<string | null> {
  const dir = process.env.JL_SCREENSHOT_DIR;
  if (process.env.JL_PROGRESS_SCREENSHOTS !== "1" || !dir) return null;
  const page = currentPage();
  if (!page) return null;
  try {
    mkdirSync(join(dir, "progress"), { recursive: true });
    const path = join(dir, "progress", `${stepId}.jpg`);
    await page.screenshot({ path, type: "jpeg", quality: 45, scale: "css", timeout: 3000 });
    return path;
  } catch {
    return null;
  }
}

export async function step(meta: StepMeta, body: () => Promise<unknown>): Promise<void> {
  const parentStepId = globalThis.__jlCurrentStepId ?? null;
  globalThis.__jlCurrentStepId = meta.stepId;
  await waitWhileTakenOver(currentPage);
  writeStepLog({ type: "step-started", at: new Date().toISOString(), ...meta });
  try {
    await runStep(meta, body);
  } finally {
    globalThis.__jlCurrentStepId = parentStepId;
  }
}

async function runStep(meta: StepMeta, body: () => Promise<unknown>): Promise<void> {
  try {
    const result = (await body()) as { summary?: unknown } | undefined;
    writeStepLog({
      type: "step-finished",
      at: new Date().toISOString(),
      stepId: meta.stepId,
      status: "passed",
      error: null,
      screenshot: meta.kind === "macro" || meta.kind === "login" ? null : await progressScreenshot(meta.stepId),
      observed: result && typeof result.summary === "string" ? result.summary : null
    });
  } catch (error) {
    const info = errorInfo(error);
    writeStepLog({
      type: "step-finished",
      at: new Date().toISOString(),
      stepId: meta.stepId,
      status: info.blocked ? "blocked" : "failed",
      error: { code: info.code, message: info.message },
      screenshot: null,
      observed: info.observed
    });
    throw error;
  }
}

// A judgment on a screen that is still loading comes back inconclusive; judge once more after
// the page settles before the step is blocked (design.md §5.1).
export async function settle<T>(judge: () => Promise<T>, waitMs = Number(process.env.JL_SETTLE_MS ?? 3000)): Promise<T> {
  try {
    return await judge();
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "ASSERTION_INCONCLUSIVE") throw error;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return judge();
  }
}

export async function screenshot(stepId: string, label: string): Promise<void> {
  const page = currentPage();
  const dir = process.env.JL_SCREENSHOT_DIR;
  if (!page || !dir) return;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${stepId}.png`);
  await page.screenshot({ path, fullPage: false });
  writeStepLog({ type: "screenshot", at: new Date().toISOString(), stepId, path, label });
}
