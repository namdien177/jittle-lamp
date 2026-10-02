// Secret values the run knows are replaced before anything is written or sent (design.md §11).
// e2e refuses secrets shorter than 6 characters; the same floor keeps redaction from eating
// ordinary short strings such as "100" inside timestamps.
export const minSecretLength = 6;

function encodings(value: string): string[] {
  const variants = [
    value,
    encodeURIComponent(value),
    new URLSearchParams({ v: value }).toString().slice(2),
    JSON.stringify(value).slice(1, -1),
    Buffer.from(value, "utf8").toString("base64")
  ];
  return variants.filter((variant) => variant.length >= minSecretLength);
}

export function createRedactor(secrets: readonly string[]): (text: string) => string {
  const values = [...new Set(secrets.filter((value) => value.length >= minSecretLength).flatMap(encodings))].sort((a, b) => b.length - a.length);
  if (values.length === 0) return (text) => text;
  const pattern = new RegExp(values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return (text) => text.replace(pattern, "[redacted]");
}

// Redacts string leaves only, so numbers, keys and structure stay intact.
export function redactJson<T>(value: T, redact: (text: string) => string): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redact(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    return node;
  };
  return walk(value) as T;
}
