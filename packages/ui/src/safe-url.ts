// Links in test cases come from transcripts and imports. Only http(s) URLs become clickable; anything
// else (javascript:, data:, file:, relative paths) is shown as text.
export function safeExternalHref(value: string): string | null {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
