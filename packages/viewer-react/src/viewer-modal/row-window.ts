export const evidenceRowHeight = 52;

export function getRowWindow(count: number, scrollTop: number, height: number, overscan = 8) {
  const first = Math.min(Math.max(0, count - 1), Math.max(0, Math.floor(scrollTop / evidenceRowHeight)));
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + Math.ceil(Math.max(height, evidenceRowHeight) / evidenceRowHeight) + overscan);
  return { start, end, before: start * evidenceRowHeight, after: (count - end) * evidenceRowHeight };
}
