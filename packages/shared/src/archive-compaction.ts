import type { ArchiveConsoleEntry, ArchiveNetworkEntry, SessionArchive } from "./session";

// Bump when the rules below change, so archives compacted by older rules are compacted again
// (the backend re-runs them lazily when an evidence is opened).
export const archiveCompactionVersion = 1;

type NetworkPayload = ArchiveNetworkEntry["payload"];
type BodyCapture = NonNullable<NetworkPayload["request"]["body"]>;
type HeaderEntry = NetworkPayload["request"]["headers"][number];

const maskMarker = "****";
// Values shorter than this are masked whole: keeping 4 + 4 characters would reveal most of them.
const minPartialMaskLength = 12;

// Shows the first and last 4 characters so two values can still be told apart while debugging.
export function maskSecretValue(value: string): string {
  if (value.length === 0 || value.includes(maskMarker)) return value;
  if (value.length < minPartialMaskLength) return maskMarker;
  return `${value.slice(0, 4)}${maskMarker}${value.slice(-4)}`;
}

const sensitiveHeaderNames = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "x-auth-token",
  "x-access-token",
  "x-refresh-token",
  "x-csrf-token",
  "x-xsrf-token",
  "csrf-token",
  "x-amz-security-token",
  "x-goog-api-key",
  "x-session-token",
  "x-jittle-lamp-token"
]);

const sensitiveNameFragments = [
  "token",
  "secret",
  "password",
  "passwd",
  "signature",
  "credential",
  "apikey",
  "api_key",
  "api-key",
  "authorization",
  "session"
];
const sensitiveExactNames = new Set(["auth", "pwd", "otp", "jwt", "pin", "ssn"]);
// Short names that are secrets in a URL (OAuth `code`, signed `sig`, `key`) but ordinary fields in
// a JSON body, so they are masked only in query strings.
const sensitiveQueryNames = new Set(["code", "key", "sig"]);

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  return sensitiveExactNames.has(lower) || sensitiveNameFragments.some((fragment) => lower.includes(fragment));
}

function isSensitiveQueryName(name: string): boolean {
  return isSensitiveName(name) || sensitiveQueryNames.has(name.toLowerCase());
}

function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return sensitiveHeaderNames.has(lower) || isSensitiveName(lower);
}

// `Bearer abc…` keeps its scheme; only the credential is masked.
function maskAuthorizationValue(value: string): string {
  const match = value.match(/^([A-Za-z][\w-]*)\s+(\S.*)$/);
  return match ? `${match[1]} ${maskSecretValue(match[2] ?? "")}` : maskSecretValue(value);
}

// `a=1; b=2` keeps the cookie names; every value is masked because any of them may be a session.
function maskCookieHeaderValue(value: string): string {
  return value
    .split(";")
    .map((part) => {
      const index = part.indexOf("=");
      if (index < 0) return part;
      return `${part.slice(0, index)}=${maskSecretValue(part.slice(index + 1).trim())}`;
    })
    .join(";");
}

// `sid=abc; Path=/; HttpOnly` keeps the attributes; only the value is masked.
function maskSetCookieValue(value: string): string {
  const separator = value.indexOf(";");
  const pair = separator < 0 ? value : value.slice(0, separator);
  const attributes = separator < 0 ? "" : value.slice(separator);
  const index = pair.indexOf("=");
  if (index < 0) return value;
  return `${pair.slice(0, index)}=${maskSecretValue(pair.slice(index + 1))}${attributes}`;
}

function maskHeader(header: HeaderEntry): HeaderEntry {
  const lower = header.name.toLowerCase();
  if (lower === "cookie") return { ...header, value: maskCookieHeaderValue(header.value) };
  if (lower === "set-cookie") return { ...header, value: header.value.split("\n").map(maskSetCookieValue).join("\n") };
  if (lower === "authorization" || lower === "proxy-authorization") return { ...header, value: maskAuthorizationValue(header.value) };
  if (isSensitiveHeader(lower)) return { ...header, value: maskSecretValue(header.value) };
  return header;
}

export function maskSensitiveUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  let changed = false;
  if (url.username || url.password) {
    url.username = url.username ? maskSecretValue(url.username) : "";
    url.password = url.password ? maskSecretValue(url.password) : "";
    changed = true;
  }
  const params = new URLSearchParams(url.search);
  for (const [name, value] of [...params.entries()]) {
    if (!isSensitiveQueryName(name)) continue;
    const masked = maskSecretValue(value);
    if (masked !== value) {
      params.set(name, masked);
      changed = true;
    }
  }
  if (!changed) return input;
  const search = params.toString();
  url.search = search ? `?${search}` : "";
  return url.toString();
}

// Masks `"password": "…"` style pairs in JSON and `password=…` pairs in form bodies without
// parsing them, so truncated bodies are handled too.
const jsonSecretPattern = /("([^"\\]*)"\s*:\s*")((?:[^"\\]|\\.)*)(")/g;
const formSecretPattern = /(^|[&?])([^=&\s]+)=([^&\s]*)/g;

function maskBodyText(value: string, mimeType: string | undefined): string {
  let next = value.replace(jsonSecretPattern, (match, prefix: string, name: string, secret: string, suffix: string) =>
    isSensitiveName(name) ? `${prefix}${maskSecretValue(secret)}${suffix}` : match
  );
  if (mimeType?.includes("x-www-form-urlencoded") || /^[^{[<\s][^\s]*=/.test(next)) {
    next = next.replace(formSecretPattern, (match, lead: string, name: string, secret: string) => {
      let decodedName = name;
      try {
        decodedName = decodeURIComponent(name);
      } catch {
        // Keep the raw name.
      }
      return isSensitiveName(decodedName) ? `${lead}${name}=${maskSecretValue(secret)}` : match;
    });
  }
  return next;
}

const staticSubtypes = new Set(["stylesheet", "script", "image", "font", "media"]);
const staticMimePattern = /^(image|font|audio|video)\/|^(text\/css|text\/javascript|application\/(x-)?javascript|application\/wasm|application\/font)/i;

function bodyMimeType(payload: NetworkPayload): string | undefined {
  const fromBody = payload.response?.body?.mimeType;
  if (fromBody) return fromBody;
  return payload.response?.headers.find((header) => header.name.toLowerCase() === "content-type")?.value;
}

export function isStaticAssetRequest(entry: Pick<ArchiveNetworkEntry, "subtype" | "payload">): boolean {
  if (staticSubtypes.has(entry.subtype) || (entry.payload.subtype && staticSubtypes.has(entry.payload.subtype))) return true;
  if (entry.subtype !== "other") return false;
  const mimeType = bodyMimeType(entry.payload);
  return mimeType !== undefined && staticMimePattern.test(mimeType);
}

// Analytics, tag managers, session replay and error-ingest beacons. They add volume, not
// debugging value; only their count is kept in the archive notes.
const trackingHostSuffixes = [
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "googleadservices.com",
  "googlesyndication.com",
  "doubleclick.net",
  "stats.g.doubleclick.net",
  "segment.io",
  "segment.com",
  "segmentapis.com",
  "mixpanel.com",
  "amplitude.com",
  "heap.io",
  "heapanalytics.com",
  "hotjar.com",
  "hotjar.io",
  "fullstory.com",
  "clarity.ms",
  "logrocket.io",
  "lr-ingest.io",
  "lr-in.com",
  "sentry.io",
  "ingest.sentry.io",
  "browser-intake-datadoghq.com",
  "browser-intake-datadoghq.eu",
  "bam.nr-data.net",
  "bam-cell.nr-data.net",
  "connect.facebook.net",
  "px.ads.linkedin.com",
  "analytics.tiktok.com",
  "bat.bing.com",
  "posthog.com",
  "i.posthog.com",
  "plausible.io",
  "matomo.cloud"
];
const trackingPathPatterns = [/^\/tr\/?$/, /\/collect\/?$/, /\/g\/collect\/?$/, /\/j\/collect\/?$/];

function trackingHost(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const matched = trackingHostSuffixes.find((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (matched) return host;
  if (host.endsWith("facebook.com") && trackingPathPatterns.some((pattern) => pattern.test(parsed.pathname))) return host;
  return null;
}

function omittedBody(body: BodyCapture, reason: string): BodyCapture {
  const byteLength = body.byteLength ?? body.omittedByteLength;
  return {
    disposition: "omitted",
    ...(body.mimeType ? { mimeType: body.mimeType } : {}),
    ...(byteLength !== undefined ? { byteLength, omittedByteLength: byteLength } : {}),
    reason
  };
}

function compactBody(body: BodyCapture | undefined, isStatic: boolean): BodyCapture | undefined {
  if (!body) return undefined;
  if (body.disposition === "omitted" && body.value === undefined) return body;
  if (isStatic && body.value !== undefined) return omittedBody(body, "Static asset bodies are not kept in the archive.");
  if (body.encoding === "base64" && body.value !== undefined) return omittedBody(body, "Binary bodies are not kept in the archive.");
  if (body.value === undefined) return body;
  const value = maskBodyText(body.value, body.mimeType);
  return value === body.value ? body : { ...body, value };
}

const staticResponseHeaderNames = new Set(["content-type", "content-length", "content-encoding", "cache-control"]);

function compactNetworkPayload(payload: NetworkPayload, isStatic: boolean): NetworkPayload {
  const requestBody = compactBody(payload.request.body, isStatic);
  const responseBody = compactBody(payload.response?.body, isStatic);
  const request = {
    headers: isStatic ? [] : payload.request.headers.map(maskHeader),
    cookies: isStatic
      ? []
      : payload.request.cookies.map((entry) => ({ ...entry, cookie: { ...entry.cookie, value: maskSecretValue(entry.cookie.value) } })),
    ...(requestBody ? { body: requestBody } : {})
  };
  const response = payload.response
    ? {
        headers: isStatic
          ? payload.response.headers.filter((header) => staticResponseHeaderNames.has(header.name.toLowerCase()))
          : payload.response.headers.map(maskHeader),
        setCookieHeaders: isStatic ? [] : payload.response.setCookieHeaders.map(maskSetCookieValue),
        setCookies: isStatic
          ? []
          : payload.response.setCookies.map((cookie) => ({
              ...cookie,
              value: maskSecretValue(cookie.value),
              raw: maskSetCookieValue(cookie.raw)
            })),
        ...(responseBody ? { body: responseBody } : {})
      }
    : undefined;
  return {
    ...payload,
    url: maskSensitiveUrl(payload.url),
    request,
    ...(response ? { response } : {})
  };
}

// Repeated identical console lines in a row collapse into the first one, marked with a count.
const repeatSuffixPattern = / \(×(\d+)\)$/;
const maxConsoleEntries = 3000;

function compactConsole(entries: ArchiveConsoleEntry[]): { entries: ArchiveConsoleEntry[]; collapsed: number; dropped: number } {
  const result: ArchiveConsoleEntry[] = [];
  const repeatCounts: number[] = [];
  const baseMessages: string[] = [];
  let collapsed = 0;
  for (const entry of entries) {
    const existingRepeat = Number(entry.payload.message.match(repeatSuffixPattern)?.[1] ?? 1);
    const baseMessage = entry.payload.message.replace(repeatSuffixPattern, "");
    const lastIndex = result.length - 1;
    const last = result[lastIndex];
    if (
      last &&
      last.payload.level === entry.payload.level &&
      baseMessages[lastIndex] === baseMessage &&
      last.payload.args.join("\u0000") === entry.payload.args.join("\u0000") &&
      JSON.stringify(last.tags ?? []) === JSON.stringify(entry.tags ?? [])
    ) {
      repeatCounts[lastIndex] = (repeatCounts[lastIndex] ?? 1) + existingRepeat;
      collapsed += 1;
      continue;
    }
    result.push(entry);
    repeatCounts.push(existingRepeat);
    baseMessages.push(baseMessage);
  }
  const withCounts = result.map((entry, index) => {
    const count = repeatCounts[index] ?? 1;
    const message = count > 1 ? `${baseMessages[index]} (×${count})` : (baseMessages[index] ?? entry.payload.message);
    return message === entry.payload.message ? entry : { ...entry, payload: { ...entry.payload, message } };
  });

  if (withCounts.length <= maxConsoleEntries) return { entries: withCounts, collapsed, dropped: 0 };
  // Over the cap, the oldest debug and info lines go first; warnings and errors are kept.
  let excess = withCounts.length - maxConsoleEntries;
  const keep = withCounts.map(() => true);
  for (let index = 0; index < withCounts.length && excess > 0; index += 1) {
    const level = withCounts[index]?.payload.level;
    if (level === "debug" || level === "info") {
      keep[index] = false;
      excess -= 1;
    }
  }
  const kept = withCounts.filter((_, index) => keep[index]);
  return { entries: kept, collapsed, dropped: withCounts.length - kept.length };
}

const compactionNotePrefix = "Archive compaction:";

function compactionNote(stats: {
  preflight: number;
  tracking: Map<string, number>;
  staticBodies: number;
  binaryBodies: number;
  consoleCollapsed: number;
  consoleDropped: number;
}): string | null {
  const parts: string[] = [];
  if (stats.preflight > 0) parts.push(`removed ${stats.preflight} CORS preflight (OPTIONS) requests`);
  const trackingTotal = [...stats.tracking.values()].reduce((sum, count) => sum + count, 0);
  if (trackingTotal > 0) {
    const hosts = [...stats.tracking.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([host, count]) => `${host} ×${count}`)
      .join(", ");
    parts.push(`removed ${trackingTotal} analytics requests (${hosts})`);
  }
  if (stats.staticBodies > 0) parts.push(`dropped ${stats.staticBodies} static asset bodies`);
  if (stats.binaryBodies > 0) parts.push(`dropped ${stats.binaryBodies} binary bodies`);
  if (stats.consoleCollapsed > 0) parts.push(`collapsed ${stats.consoleCollapsed} repeated console lines`);
  if (stats.consoleDropped > 0) parts.push(`dropped ${stats.consoleDropped} older debug/info console lines`);
  return parts.length > 0 ? `${compactionNotePrefix} ${parts.join("; ")}.` : null;
}

function hasDroppableBody(body: BodyCapture | undefined, isStatic: boolean, encoding: "any" | "base64"): boolean {
  if (!body || body.value === undefined) return false;
  return encoding === "base64" ? !isStatic && body.encoding === "base64" : isStatic;
}

// Drops what does not help debugging and masks secrets. Safe to run more than once: a compacted
// archive comes back with the same content.
export function compactSessionArchive(archive: SessionArchive): SessionArchive {
  const tracking = new Map<string, number>();
  let preflight = 0;
  let staticBodies = 0;
  let binaryBodies = 0;
  const network: ArchiveNetworkEntry[] = [];

  for (const entry of archive.sections.network) {
    if (entry.payload.method.toUpperCase() === "OPTIONS") {
      preflight += 1;
      continue;
    }
    const host = trackingHost(entry.payload.url);
    if (host) {
      tracking.set(host, (tracking.get(host) ?? 0) + 1);
      continue;
    }
    const isStatic = isStaticAssetRequest(entry);
    for (const body of [entry.payload.request.body, entry.payload.response?.body]) {
      if (hasDroppableBody(body, isStatic, "any")) staticBodies += 1;
      if (hasDroppableBody(body, isStatic, "base64")) binaryBodies += 1;
    }
    network.push({ ...entry, payload: compactNetworkPayload(entry.payload, isStatic) });
  }

  const consoleResult = compactConsole(archive.sections.console);
  const note = compactionNote({
    preflight,
    tracking,
    staticBodies,
    binaryBodies,
    consoleCollapsed: consoleResult.collapsed,
    consoleDropped: consoleResult.dropped
  });
  const previousNotes = archive.notes.filter((entry) => entry.startsWith(compactionNotePrefix));
  const otherNotes = archive.notes.filter((entry) => !entry.startsWith(compactionNotePrefix));
  // A second pass finds nothing new to remove, so the first pass's note is kept.
  const notes = note ? [...otherNotes, ...previousNotes, note] : archive.notes;

  return {
    ...archive,
    summary: {
      ...archive.summary,
      requestCount: archive.summary.requestCount === null ? null : network.length
    },
    sections: {
      ...archive.sections,
      network,
      console: consoleResult.entries
    },
    notes
  };
}
