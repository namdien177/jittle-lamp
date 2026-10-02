import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { credentials, secrets, unique } from "e2e";

import { currentPage } from "./engine";
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
        out[param] = credentials.user(binding.profile).password;
        break;
      case "secret":
        out[param] = secrets.get(binding.name);
        break;
      case "extracted":
        out[param] = unique(extracted.get(binding.name) ?? "");
        break;
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

function errorInfo(error: unknown): { code: string; message: string; blocked: boolean; observed: string | null } {
  const record = (error ?? {}) as { code?: unknown; message?: unknown; blocked?: unknown; explanation?: unknown };
  const code = typeof record.code === "string" ? record.code : "STEP_FAILED";
  const message = typeof record.message === "string" ? record.message : String(error);
  const explanation = typeof record.explanation === "string" ? record.explanation : null;
  return { code, message, blocked: record.blocked === true, observed: explanation };
}

export async function step(meta: StepMeta, body: () => Promise<unknown>): Promise<void> {
  writeStepLog({ type: "step-started", at: new Date().toISOString(), ...meta });
  try {
    const result = (await body()) as { summary?: unknown } | undefined;
    writeStepLog({
      type: "step-finished",
      at: new Date().toISOString(),
      stepId: meta.stepId,
      status: "passed",
      error: null,
      screenshot: null,
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

export async function screenshot(stepId: string, label: string): Promise<void> {
  const page = currentPage();
  const dir = process.env.JL_SCREENSHOT_DIR;
  if (!page || !dir) return;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${stepId}.png`);
  await page.screenshot({ path, fullPage: false });
  writeStepLog({ type: "screenshot", at: new Date().toISOString(), stepId, path, label });
}
