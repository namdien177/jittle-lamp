import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { safeExternalHref } from "@jittle-lamp/ui";

import { defaultDuplicateTitle, duplicateTitleForRequest } from "../apps/evidence-web/src/test-cases/duplicate/find-replace";
import { decodeXmlText, maxXlsxBytes, readXlsxRows } from "../apps/evidence-web/src/test-cases/import/xlsx";
import { keyStartsWith, testKeys } from "../apps/evidence-web/src/test-cases/query-keys";
import { approveCleanPrompt } from "../apps/evidence-web/src/test-cases/review/review-queue-state";

// Review fixes for 1c.4: org-scoped shared query keys, duplicate title, XLSX guards, shift+a
// confirmation and http(s)-only links.

const webSrc = join(import.meta.dir, "..", "apps", "evidence-web", "src");
const read = (path: string) => readFileSync(join(webSrc, path), "utf8");

describe("org-scoped query keys shared by both query modules", () => {
  it("puts the organisation in every key and separates organisations", () => {
    const a = testKeys.environments("org-a");
    const b = testKeys.environments("org-b");
    expect(a).not.toEqual(b);
    for (const key of [a, testKeys.caseList("org-a", {}, {}), testKeys.run("org-a", "r1"), testKeys.notifications("org-a"), testKeys.importBatch("org-a", "b1")]) {
      expect(keyStartsWith(key, testKeys.org("org-a"))).toBe(true);
      expect(keyStartsWith(key, testKeys.all())).toBe(true);
    }
  });

  it("refreshes the list, details and review queue from one cases prefix", () => {
    const cases = testKeys.cases("org-a");
    for (const key of [testKeys.caseList("org-a", { q: "x" }, "updated"), testKeys.caseDetail("org-a", "c1"), testKeys.reviewQueue("org-a"), testKeys.similar("org-a", "t", null)]) {
      expect(keyStartsWith(key, cases)).toBe(true);
    }
    expect(keyStartsWith(testKeys.environments("org-a"), cases)).toBe(false);
    expect(keyStartsWith(testKeys.caseDetail("org-b", "c1"), cases)).toBe(false);
  });

  it("is the only source of keys in both modules and is invalidated on organisation switch", () => {
    for (const file of ["test-cases/queries.ts", "test-cases/admin-queries.ts"]) {
      const source = read(file);
      expect(source).toContain('from "./query-keys"');
      expect(source).not.toMatch(/queryKey:\s*\[/);
      expect(source).not.toMatch(/\["test-(cases|config|runs|admin)"/);
    }
    const queries = read("queries.ts");
    const switchHook = queries.slice(queries.indexOf("export function useSelectActiveOrganization"), queries.indexOf("export function useAcceptInvitation"));
    expect(switchHook).toContain("testKeys.all()");
  });
});

describe("duplicate title", () => {
  it("defaults to the replaced title like the backend, else '<title> (copy)'", () => {
    expect(defaultDuplicateTitle("HQ admin logout", [{ find: "HQ admin", replace: "Branch admin" }])).toBe("Branch admin logout");
    expect(defaultDuplicateTitle("HQ admin logout", [{ find: "HQ_ADMIN", replace: "BRANCH_ADMIN" }])).toBe("HQ admin logout (copy)");
  });

  it("sends a title only when the user typed one for a single case", () => {
    expect(duplicateTitleForRequest({ single: true, edited: false, title: "Branch admin logout" })).toBeUndefined();
    expect(duplicateTitleForRequest({ single: true, edited: true, title: "  Mine  " })).toBe("Mine");
    expect(duplicateTitleForRequest({ single: true, edited: true, title: "  " })).toBeUndefined();
    expect(duplicateTitleForRequest({ single: false, edited: true, title: "x" })).toBeUndefined();
  });
});

describe("xlsx guards", () => {
  it("leaves out-of-range numeric entities as text", () => {
    expect(decodeXmlText("a&#x110000;b&#99999999;c&#65;")).toBe("a&#x110000;b&#99999999;cA");
  });

  it("rejects files over the size limit before unzipping", () => {
    expect(() => readXlsxRows(new Uint8Array(maxXlsxBytes + 1))).toThrow("the limit is 20 MB");
  });
});

describe("shift+a confirmation", () => {
  it("asks with the count of lint-clean cases, or not at all", () => {
    const prompt = approveCleanPrompt([
      { id: "a", lintErrors: 0, lintWarnings: 0 },
      { id: "b", lintErrors: 0, lintWarnings: 1 },
      { id: "c", lintErrors: 0, lintWarnings: 0 }
    ]);
    expect(prompt).toEqual({
      ids: ["a", "c"],
      title: "Approve 2 cases?",
      confirmLabel: "Approve 2",
      description: "Every case in the queue without lint errors or warnings (2 of 3) becomes active and runnable."
    });
    expect(approveCleanPrompt([{ id: "b", lintErrors: 1, lintWarnings: 0 }])).toBeNull();
  });
});

describe("external links", () => {
  it("allows only http(s) hrefs", () => {
    expect(safeExternalHref("https://littlelives.atlassian.net/browse/PCF-1")).toBe("https://littlelives.atlassian.net/browse/PCF-1");
    expect(safeExternalHref(" http://example.com ")).toBe("http://example.com/");
    expect(safeExternalHref("javascript:alert(1)")).toBeNull();
    expect(safeExternalHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeExternalHref("data:text/html,x")).toBeNull();
    expect(safeExternalHref("/relative")).toBeNull();
    expect(safeExternalHref("https://")).toBeNull();
  });
});
