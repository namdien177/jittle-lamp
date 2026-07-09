import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(
  new URL("../apps/evidence-web/src/index.css", import.meta.url),
  "utf8"
);

describe("evidence web global CSS", () => {
  test("applies stable scrollbar gutter only to explicit overflow surfaces", () => {
    expect(css).toContain('@apply scrollbar-gutter-stable;');
    expect(css).toMatch(/:where\([\s\S]*?\[class~="overflow-auto"\][\s\S]*?\[class~="overflow-y-auto"\][\s\S]*?\)/);
    expect(css).not.toMatch(/:where\([\s\S]*?\bhtml,\s*[\s\S]*?@apply scrollbar-gutter-stable;/);
    expect(css).not.toMatch(/:where\([\s\S]*?\bbody,\s*[\s\S]*?@apply scrollbar-gutter-stable;/);
    expect(css).not.toMatch(/:where\([\s\S]*?\.jl-scroll,\s*[\s\S]*?@apply scrollbar-gutter-stable;/);
  });
});
