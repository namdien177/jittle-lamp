import { tool } from "ai";
import { defineTool, type DefinedTool } from "e2e/agent";
import { z } from "zod/v4";

import { lookupData, type QueryDeps } from "./query";

// `lookup_data`: a read-only project tool (roadmap 2026-10-13 §5.2) the generated e2e.config.ts
// registers when the run names postgres profiles, so an [Act] step can ask for "any K1 student id"
// mid-step. Read-only tools leave no replay gap (`mutates: false`); the answer is at most 20
// redacted rows. Off with JL_QUERY_TOOL=0.

export function queryToolEnabled(env: Readonly<Record<string, string | undefined>>, profiles: readonly string[]): boolean {
  if (profiles.length === 0) return false;
  return env.JL_QUERY_TOOL !== "0";
}

export function createLookupDataTool(options: { profiles: readonly string[]; deps?: QueryDeps }): DefinedTool {
  const profiles = [...options.profiles];
  return defineTool(
    tool({
      description: `Look up test data in a database profile (${profiles.join(", ")}) with a plain-language question. Read-only; returns at most 20 rows with sensitive columns redacted.`,
      inputSchema: z.object({
        profile: z.string().describe(`One of: ${profiles.join(", ")}`),
        question: z.string().min(1).describe("What rows to find, e.g. a K1 student with a pending registration")
      }),
      execute: async ({ profile, question }) => {
        // Only the profiles the run was given; a made-up name is refused before any connection.
        if (!profiles.includes(profile)) return { error: `Unknown profile "${profile}". Use one of: ${profiles.join(", ")}.` };
        return lookupData(profile, question, options.deps ?? {});
      }
    }),
    { mutates: false }
  );
}
