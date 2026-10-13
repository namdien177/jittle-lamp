import { existsSync, readFileSync } from "node:fs";

import { writeStepLog } from "./step-log";

// Variables produced while the run executes (roadmap 2026-10-13 §2.6): [Extract] values, [API]
// and [Query] bindings, and the outputs a reused run supplied for a [Use] block. Every value is
// kept in memory for `{name}` substitution and appended to the step log as an `output` event so
// the report, the backend and the run page see it. Inside a `[Use: KEY as alias]` block a value is
// published under `alias.name`; a plain `name` stays visible too while the block runs.
//
// This module runs inside the e2e worker: no @jittle-lamp/shared imports.

const values = new Map<string, unknown>();
let seeded = false;

// Outputs a reused run supplied before the worker started (JL_REUSE_FILE, written by the runner).
function seedFromEnv(): void {
  if (seeded) return;
  seeded = true;
  const path = process.env.JL_REUSE_FILE;
  if (!path || !existsSync(path)) return;
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as { outputs?: Record<string, string> };
    for (const [name, value] of Object.entries(file.outputs ?? {})) values.set(name, value);
  } catch {
    // An unreadable file means no reuse; the block's steps are the ones the generated test skips.
  }
}

export function outputText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

export function setOutput(name: string, value: unknown, options: { stepId: string | null; alias: string | null; log?: unknown }): void {
  seedFromEnv();
  const names = options.alias ? [`${options.alias}.${name}`, name] : [name];
  for (const key of names) values.set(key, value);
  // Published once under its namespaced name; the plain name is a convenience inside the block.
  writeStepLog({ type: "output", at: new Date().toISOString(), stepId: options.stepId ?? "", name: names[0] ?? name, value: outputText("log" in options ? options.log : value) });
}

// `{student.id}` reads field `id` of the JSON value bound to `student`; `{registration.applicationId}`
// reads the output `registration.applicationId` itself when it was published under that name.
export function getOutput(name: string): unknown {
  seedFromEnv();
  if (values.has(name)) return values.get(name);
  const parts = name.split(".");
  for (let split = parts.length - 1; split >= 1; split -= 1) {
    const root = parts.slice(0, split).join(".");
    if (!values.has(root)) continue;
    const value = parseIfJson(values.get(root));
    const found = walk(value, parts.slice(split));
    if (found !== undefined) return found;
  }
  return undefined;
}

export function hasOutput(name: string): boolean {
  return getOutput(name) !== undefined;
}

export function outputTextOf(name: string): string {
  const value = getOutput(name);
  return value === undefined ? "" : outputText(value);
}

export function allOutputs(): Record<string, string> {
  seedFromEnv();
  return Object.fromEntries([...values].map(([name, value]) => [name, outputText(value)]));
}

function parseIfJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function walk(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// Test seam: forget everything (the worker never calls this).
export function resetOutputs(): void {
  values.clear();
  seeded = false;
}
