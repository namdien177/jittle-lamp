export function formatRelativeTime(value: string | number): string {
  const millis = typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isFinite(millis)) return typeof value === "string" ? value : "";

  const deltaSeconds = Math.round((millis - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (Math.abs(deltaSeconds) < 60) return formatter.format(deltaSeconds, "second");

  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) return formatter.format(deltaMinutes, "minute");

  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return formatter.format(deltaHours, "hour");

  const deltaDays = Math.round(deltaHours / 24);
  if (Math.abs(deltaDays) < 30) return formatter.format(deltaDays, "day");

  const deltaMonths = Math.round(deltaDays / 30);
  if (Math.abs(deltaMonths) < 12) return formatter.format(deltaMonths, "month");

  const deltaYears = Math.round(deltaMonths / 12);
  return formatter.format(deltaYears, "year");
}

export async function copyToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "absolute";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}
