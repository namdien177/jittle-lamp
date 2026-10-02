import { isSafeResourceId } from "../../deep-link";

// Pages that only the web app has (structured editor, review queue, import wizard). The desktop
// app opens them in the system browser on the configured web origin (design.md §7 parity).

export function webUrl(webOrigin: string, path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;
  let origin: URL;
  try {
    origin = new URL(webOrigin);
  } catch {
    return null;
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") return null;
  const url = new URL(path, origin);
  return url.origin === origin.origin ? url.toString() : null;
}

export const webPaths = {
  caseEditor: (testCaseId: string) => (isSafeResourceId(testCaseId) ? `/test-cases?case=${testCaseId}&tab=steps` : null),
  reviewQueue: () => "/test-cases/review",
  importCases: () => "/test-cases/import",
  importBatch: (batchId: string) => (isSafeResourceId(batchId) ? `/test-cases/import/${batchId}` : null)
};
