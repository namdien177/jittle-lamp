// Rows have a fixed height in CSS (.jl-vm-row) so the windowed list can place them by index.
export const evidenceRowHeight = 40;

export function getRowWindow(count: number, scrollTop: number, height: number, overscan = 8) {
  const first = Math.min(Math.max(0, count - 1), Math.max(0, Math.floor(scrollTop / evidenceRowHeight)));
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + Math.ceil(Math.max(height, evidenceRowHeight) / evidenceRowHeight) + overscan);
  return { start, end, before: start * evidenceRowHeight, after: (count - end) * evidenceRowHeight };
}
