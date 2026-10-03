// `jittle-lamp://` deep links (design.md §14). Pure so the Electron main process, the renderer and
// root tests share one parser. Only targets listed here can be opened; everything else is ignored.

export const deepLinkScheme = "jittle-lamp";

export type DeepLinkTarget = { kind: "run"; runId: string };

// Run IDs are UUIDs or similar opaque IDs: letters, digits, `-` and `_`, no dots or separators, so
// a parsed ID can never become a path segment like `..` or carry a query of its own.
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const maxDeepLinkLength = 2048;

export function isSafeResourceId(value: unknown): value is string {
  return typeof value === "string" && runIdPattern.test(value);
}

export const isSafeRunId = isSafeResourceId;

/** Parses `jittle-lamp://run?runId=<id>`; returns null for anything else. */
export function parseDeepLink(raw: unknown): DeepLinkTarget | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > maxDeepLinkLength) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== `${deepLinkScheme}:`) return null;
  if (url.username || url.password || url.port || url.hash) return null;

  // `jittle-lamp://run?…` puts the action in the host; `jittle-lamp:run?…` and
  // `jittle-lamp:///run?…` put it in the path. Accept these spellings and nothing deeper.
  const action = (url.host || url.pathname.replace(/^\/+/, "")).replace(/\/$/, "").toLowerCase();
  if (url.host && url.pathname !== "" && url.pathname !== "/") return null;
  if (action !== "run") return null;

  const runIds = url.searchParams.getAll("runId");
  if (runIds.length !== 1) return null;
  const runId = runIds[0];
  return isSafeRunId(runId) ? { kind: "run", runId } : null;
}

/** Windows and Linux pass the link as a command-line argument of the (second) instance. */
export function findDeepLinkInArgv(argv: readonly string[]): string | null {
  const prefix = `${deepLinkScheme}:`;
  for (const arg of argv) {
    if (arg.toLowerCase().startsWith(prefix)) return arg;
  }
  return null;
}

export function deepLinkTargetPath(target: DeepLinkTarget): string {
  return `/test-runs/${encodeURIComponent(target.runId)}`;
}

export function buildRunDeepLink(runId: string): string | null {
  return isSafeRunId(runId) ? `${deepLinkScheme}://run?runId=${runId}` : null;
}

/** True when `value` is the same local file as `expected` (both file: URLs), ignoring query and hash. */
export function isSameFileUrl(value: string, expected: string): boolean {
  try {
    const url = new URL(value);
    const target = new URL(expected);
    return url.protocol === "file:" && target.protocol === "file:" && url.host === target.host && url.pathname === target.pathname;
  } catch {
    return false;
  }
}

/** Only http(s) URLs may leave the app for the system browser. */
export function isExternalHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}
