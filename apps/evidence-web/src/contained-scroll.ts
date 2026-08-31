export type VerticalScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  containerTop: number;
  containerBottom: number;
  itemTop: number;
  itemBottom: number;
};

export function calculateContainedScrollTop(
  metrics: VerticalScrollMetrics,
  edgePadding = 8
): number | null {
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const visibleTop = metrics.containerTop + edgePadding;
  const visibleBottom = metrics.containerBottom - edgePadding;

  if (metrics.itemTop < visibleTop) {
    return Math.max(0, metrics.scrollTop - (visibleTop - metrics.itemTop));
  }

  if (metrics.itemBottom > visibleBottom) {
    return Math.min(maxScrollTop, metrics.scrollTop + (metrics.itemBottom - visibleBottom));
  }

  return null;
}

export function scrollElementWithinContainer(
  container: HTMLElement,
  item: HTMLElement,
  behavior: ScrollBehavior
): void {
  const containerRect = container.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const nextScrollTop = calculateContainedScrollTop({
    scrollTop: container.scrollTop,
    scrollHeight: container.scrollHeight,
    clientHeight: container.clientHeight,
    containerTop: containerRect.top,
    containerBottom: containerRect.bottom,
    itemTop: itemRect.top,
    itemBottom: itemRect.bottom
  });

  if (nextScrollTop === null || Math.abs(nextScrollTop - container.scrollTop) < 1) return;
  container.scrollTo({ top: nextScrollTop, behavior });
}
