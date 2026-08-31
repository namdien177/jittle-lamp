import { describe, expect, test } from "bun:test";

import { calculateContainedScrollTop } from "../apps/evidence-web/src/contained-scroll";

const baseMetrics = {
  scrollTop: 120,
  scrollHeight: 1200,
  clientHeight: 300,
  containerTop: 500,
  containerBottom: 800,
  itemTop: 620,
  itemBottom: 664
};

describe("contained evidence-list scrolling", () => {
  test("does not move when the active row is already visible", () => {
    expect(calculateContainedScrollTop(baseMetrics)).toBeNull();
  });

  test("scrolls only the list far enough to reveal a row below it", () => {
    expect(
      calculateContainedScrollTop({
        ...baseMetrics,
        itemTop: 820,
        itemBottom: 864
      })
    ).toBe(192);
  });

  test("scrolls upward without going below zero", () => {
    expect(
      calculateContainedScrollTop({
        ...baseMetrics,
        scrollTop: 20,
        itemTop: 430,
        itemBottom: 474
      })
    ).toBe(0);
  });

  test("caps the list scroll at its own maximum", () => {
    expect(
      calculateContainedScrollTop({
        ...baseMetrics,
        scrollTop: 890,
        itemTop: 900,
        itemBottom: 980
      })
    ).toBe(900);
  });
});
