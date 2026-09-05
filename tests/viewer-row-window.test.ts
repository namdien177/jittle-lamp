import { expect, test } from "bun:test";
import { evidenceRowHeight, getRowWindow } from "../packages/viewer-react/src/viewer-modal/row-window";

test("windowed timelines keep DOM work bounded at the start, middle and end", () => {
  for (const count of [0, 1, 101, 10000]) {
    for (const scroll of [0, 500, 200000, 9999999]) {
      const range = getRowWindow(count, scroll, 600);
      expect(range.start).toBeGreaterThanOrEqual(0);
      expect(range.end).toBeLessThanOrEqual(count);
      expect(range.end - range.start).toBeLessThanOrEqual(Math.ceil(600 / evidenceRowHeight) + 16);
      expect(range.before + (range.end - range.start) * evidenceRowHeight + range.after).toBe(count * evidenceRowHeight);
      if (count) expect(range.end).toBeGreaterThan(range.start);
    }
  }
});
