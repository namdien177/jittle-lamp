import React from "react";

// Fixed-row-height windowing for long lists (test case library, step tables). Pure math first so
// it can be tested without a DOM; the hook only wires scroll and resize events to it.

export type VirtualWindow = {
  // Rows [start, end) are rendered.
  start: number;
  end: number;
  // Spacer heights above and below the rendered rows, in px.
  before: number;
  after: number;
  totalHeight: number;
};

export function computeVirtualWindow(input: {
  count: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}): VirtualWindow {
  const count = Math.max(0, Math.floor(input.count));
  const rowHeight = Math.max(1, input.rowHeight);
  const overscan = Math.max(0, Math.floor(input.overscan ?? 6));
  const totalHeight = count * rowHeight;
  if (count === 0) return { start: 0, end: 0, before: 0, after: 0, totalHeight: 0 };

  const maxScroll = Math.max(0, totalHeight - Math.max(0, input.viewportHeight));
  const scrollTop = Math.min(Math.max(0, input.scrollTop), maxScroll);
  const first = Math.min(count - 1, Math.floor(scrollTop / rowHeight));
  const visible = Math.ceil(Math.max(input.viewportHeight, rowHeight) / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end, before: start * rowHeight, after: (count - end) * rowHeight, totalHeight };
}

// Scroll offset that brings row `index` fully into view, or null when it already is. Used for
// keyboard navigation (j/k): no smooth scrolling, the row simply appears.
export function scrollTopForIndex(input: {
  index: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  // Space kept free at the top, e.g. a sticky header inside the scroller.
  headerHeight?: number;
}): number | null {
  const header = input.headerHeight ?? 0;
  const top = input.index * input.rowHeight;
  const bottom = top + input.rowHeight;
  const viewTop = input.scrollTop;
  const viewBottom = input.scrollTop + input.viewportHeight - header;
  if (top < viewTop) return Math.max(0, top);
  if (bottom > viewBottom) return Math.max(0, bottom - (input.viewportHeight - header));
  return null;
}

export function useVirtualWindow(input: {
  count: number;
  rowHeight: number;
  overscan?: number;
}): {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  window: VirtualWindow;
  scrollToIndex: (index: number, headerHeight?: number) => void;
} {
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = React.useState({ scrollTop: 0, height: 600 });

  React.useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setViewport((previous) =>
        previous.scrollTop === element.scrollTop && previous.height === element.clientHeight
          ? previous
          : { scrollTop: element.scrollTop, height: element.clientHeight }
      );
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(read);
    };
    read();
    element.addEventListener("scroll", schedule, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  const windowState = computeVirtualWindow({
    count: input.count,
    rowHeight: input.rowHeight,
    scrollTop: viewport.scrollTop,
    viewportHeight: viewport.height,
    ...(input.overscan !== undefined ? { overscan: input.overscan } : {})
  });

  const rowHeight = input.rowHeight;
  const scrollToIndex = React.useCallback(
    (index: number, headerHeight = 0) => {
      const element = scrollRef.current;
      if (!element) return;
      const next = scrollTopForIndex({ index, rowHeight, scrollTop: element.scrollTop, viewportHeight: element.clientHeight, headerHeight });
      if (next !== null) element.scrollTop = next;
    },
    [rowHeight]
  );

  return { scrollRef, window: windowState, scrollToIndex };
}
