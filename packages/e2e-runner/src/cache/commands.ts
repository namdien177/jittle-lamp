import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { StepScriptFile } from "../runtime/cache-store";

export type CacheListEntry = {
  keyHash: string;
  stepId: string | null;
  stepIds: string[];
  environment: string | null;
  recordedAt: string;
  actions: number;
  renderedCode: string;
  file: string;
};

export function listCache(dir: string): CacheListEntry[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        const file = JSON.parse(readFileSync(join(dir, name), "utf8")) as StepScriptFile;
        return [
          {
            keyHash: file.keyHash,
            stepId: file.stepId,
            stepIds: file.stepIds ?? (file.stepId ? [file.stepId] : []),
            environment: file.environment,
            recordedAt: file.recordedAt,
            actions: file.entry.payload.actions.length,
            renderedCode: file.renderedCode,
            file: join(dir, name)
          }
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

export function clearCache(dir: string, stepId: string | null): number {
  const entries = listCache(dir).filter((entry) => stepId === null || entry.stepIds.includes(stepId));
  for (const entry of entries) rmSync(entry.file, { force: true });
  return entries.length;
}
