// Secret values the run knows are replaced before anything is written or sent (design.md §11).
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const values = [...new Set(secrets.filter((value) => value.length >= 3))].sort((a, b) => b.length - a.length);
  if (values.length === 0) return (text) => text;
  const variants = values.flatMap((value) => [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
  const unique = [...new Set(variants)].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(unique.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return (text) => text.replace(pattern, "[redacted]");
}

export function redactJson<T>(value: T, redact: (text: string) => string): T {
  return JSON.parse(redact(JSON.stringify(value))) as T;
}
