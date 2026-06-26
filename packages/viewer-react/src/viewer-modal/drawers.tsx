import type * as React from "react";
import { Clipboard, X } from "lucide-react";

import type { TimelineItem } from "@jittle-lamp/shared";

import { buildCurl } from "./curl";
import { statusTone } from "./format";

type DrawerProps = {
  item: TimelineItem;
  onClose: () => void;
  onCopy: (value: string, label: string) => void;
};

export function NetworkDrawer(props: DrawerProps): React.JSX.Element {
  if (props.item.payload.kind === "network") {
    return <NetworkDetailDrawer item={props.item} onClose={props.onClose} onCopy={props.onCopy} />;
  }
  if (props.item.payload.kind === "console") {
    return <ConsoleDetailDrawer item={props.item} onClose={props.onClose} onCopy={props.onCopy} />;
  }
  return <ActionDetailDrawer item={props.item} onClose={props.onClose} onCopy={props.onCopy} />;
}

function NetworkDetailDrawer(props: DrawerProps): React.JSX.Element | null {
  if (props.item.payload.kind !== "network") return null;
  const payload = props.item.payload;
  const statusCode = payload.status ?? null;
  const tone = statusTone(statusCode);
  const statusText =
    statusCode !== null
      ? `${statusCode}${payload.statusText ? ` ${payload.statusText}` : ""}`
      : "—";
  const durationText =
    payload.durationMs !== undefined ? `${payload.durationMs.toFixed(0)} ms` : "—";

  return (
    <div className="jl-vm-drawer">
      <div className="jl-vm-drawer-header">
        <span>Network request</span>
        <div className="jl-vm-drawer-actions">
          <button
            type="button"
            className="jl-vm-btn"
            onClick={() => props.onCopy(buildCurl(payload), "cURL command")}
          >
            <Clipboard aria-hidden size={14} strokeWidth={2} />
            Copy cURL
          </button>
          <button type="button" className="jl-vm-btn jl-vm-btn-icon" aria-label="Close drawer" onClick={props.onClose}>
            <X aria-hidden size={16} strokeWidth={2} />
          </button>
        </div>
      </div>
      <div className="jl-vm-drawer-body">
        <div className="jl-vm-drawer-section">
          <span className="jl-vm-drawer-label">Request</span>
          <KvRow keyLabel="Method" value={payload.method} onCopy={props.onCopy} copyAs="request method" />
          <KvRow keyLabel="URL" value={payload.url} onCopy={props.onCopy} copyAs="request URL" />
          <KvRow keyLabel="Status" value={statusText} tone={tone} onCopy={props.onCopy} copyAs="response status" />
          <KvRow keyLabel="Duration" value={durationText} onCopy={props.onCopy} copyAs="duration" />
          {payload.failureText ? (
            <KvRow keyLabel="Failure" value={payload.failureText} tone="err" onCopy={props.onCopy} copyAs="failure" />
          ) : null}
        </div>
        <HeadersSection title="Request headers" headers={payload.request.headers} onCopy={props.onCopy} />
        <RequestCookiesSection cookies={payload.request.cookies} onCopy={props.onCopy} />
        <BodySection title="Request body" body={payload.request.body} onCopy={props.onCopy} />
        <HeadersSection title="Response headers" headers={payload.response?.headers ?? []} onCopy={props.onCopy} />
        <ResponseCookiesSection
          setCookieHeaders={payload.response?.setCookieHeaders ?? []}
          setCookies={payload.response?.setCookies ?? []}
          onCopy={props.onCopy}
        />
        <BodySection title="Response body" body={payload.response?.body} onCopy={props.onCopy} />
      </div>
    </div>
  );
}

function ConsoleDetailDrawer(props: DrawerProps): React.JSX.Element | null {
  if (props.item.payload.kind !== "console") return null;
  const payload = props.item.payload;
  const text = JSON.stringify(payload, null, 2);
  return (
    <div className="jl-vm-drawer">
      <div className="jl-vm-drawer-header">
        <span>Log entry</span>
        <button type="button" className="jl-vm-btn jl-vm-btn-icon" aria-label="Close drawer" onClick={props.onClose}>
          <X aria-hidden size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="jl-vm-drawer-body">
        <pre className="jl-vm-pre" onClick={() => props.onCopy(text, "log entry")}>{text}</pre>
      </div>
    </div>
  );
}

function ActionDetailDrawer(props: DrawerProps): React.JSX.Element {
  const text = JSON.stringify(props.item.payload, null, 2);
  return (
    <div className="jl-vm-drawer">
      <div className="jl-vm-drawer-header">
        <span>Action</span>
        <button type="button" className="jl-vm-btn jl-vm-btn-icon" aria-label="Close drawer" onClick={props.onClose}>
          <X aria-hidden size={16} strokeWidth={2} />
        </button>
      </div>
      <div className="jl-vm-drawer-body">
        <pre className="jl-vm-pre" onClick={() => props.onCopy(text, "action")}>{text}</pre>
      </div>
    </div>
  );
}

function KvRow(props: {
  keyLabel: string;
  value: string;
  tone?: "ok" | "err" | "";
  onCopy: (value: string, label: string) => void;
  copyAs: string;
}): React.JSX.Element {
  return (
    <div className="jl-vm-kv">
      <span className="jl-vm-kv-key">{props.keyLabel}</span>
      <button
        type="button"
        className="jl-vm-kv-val"
        data-tone={props.tone || undefined}
        onClick={() => props.onCopy(props.value, props.copyAs)}
      >
        {props.value}
      </button>
    </div>
  );
}

function HeadersSection(props: {
  title: string;
  headers: ReadonlyArray<{ name: string; value: string }>;
  onCopy: (value: string, label: string) => void;
}): React.JSX.Element {
  return (
    <div className="jl-vm-drawer-section">
      <span className="jl-vm-drawer-label">{props.title}</span>
      {props.headers.length === 0 ? (
        <span className="jl-vm-empty-line">No headers</span>
      ) : (
        props.headers.map((header, index) => (
          <div className="jl-vm-kv" key={`${props.title}-${header.name}-${index}`}>
            <button
              type="button"
              className="jl-vm-kv-val jl-vm-kv-key"
              onClick={() => props.onCopy(header.name, "header name")}
            >
              {header.name}
            </button>
            <button
              type="button"
              className="jl-vm-kv-val"
              onClick={() => props.onCopy(header.value, "header value")}
            >
              {header.value}
            </button>
          </div>
        ))
      )}
    </div>
  );
}

function RequestCookiesSection(props: {
  cookies: ReadonlyArray<{
    cookie: {
      name: string;
      value: string;
      domain?: string | undefined;
      path?: string | undefined;
      secure?: boolean | undefined;
      httpOnly?: boolean | undefined;
      sameSite?: string | undefined;
    };
    blockedReasons: ReadonlyArray<string>;
  }>;
  onCopy: (value: string, label: string) => void;
}): React.JSX.Element {
  return (
    <div className="jl-vm-drawer-section">
      <span className="jl-vm-drawer-label">Request cookies</span>
      {props.cookies.length === 0 ? (
        <span className="jl-vm-empty-line">No cookies</span>
      ) : (
        props.cookies.map((entry, index) => (
          <CookieCard
            key={`${entry.cookie.name}-${index}`}
            name={entry.cookie.name}
            value={entry.cookie.value}
            meta={cookieMeta(entry.cookie)}
            raw={`${entry.cookie.name}=${entry.cookie.value}`}
            blockedReasons={entry.blockedReasons}
            onCopy={props.onCopy}
          />
        ))
      )}
    </div>
  );
}

function ResponseCookiesSection(props: {
  setCookieHeaders: ReadonlyArray<string>;
  setCookies: ReadonlyArray<{
    name: string;
    value: string;
    domain?: string | undefined;
    path?: string | undefined;
    secure?: boolean | undefined;
    httpOnly?: boolean | undefined;
    sameSite?: string | undefined;
    raw: string;
  }>;
  onCopy: (value: string, label: string) => void;
}): React.JSX.Element {
  return (
    <div className="jl-vm-drawer-section">
      <span className="jl-vm-drawer-label">Set-Cookie</span>
      {props.setCookieHeaders.length === 0 && props.setCookies.length === 0 ? (
        <span className="jl-vm-empty-line">No Set-Cookie headers</span>
      ) : (
        <>
          {props.setCookies.map((cookie, index) => (
            <CookieCard
              key={`${cookie.name}-${index}`}
              name={cookie.name}
              value={cookie.value}
              meta={cookieMeta(cookie)}
              raw={cookie.raw}
              blockedReasons={[]}
              onCopy={props.onCopy}
            />
          ))}
          {props.setCookieHeaders.map((header, index) => (
            <pre
              key={`${header}-${index}`}
              className="jl-vm-pre jl-vm-pre-compact"
              onClick={() => props.onCopy(header, "Set-Cookie header")}
            >
              {header}
            </pre>
          ))}
        </>
      )}
    </div>
  );
}

function CookieCard(props: {
  name: string;
  value: string;
  meta: string;
  raw: string;
  blockedReasons: ReadonlyArray<string>;
  onCopy: (value: string, label: string) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="jl-vm-cookie"
      onClick={() => props.onCopy(props.raw, "cookie")}
    >
      <span className="jl-vm-cookie-main">
        <strong>{props.name}</strong>
        <span>{props.value}</span>
      </span>
      {props.meta ? <span className="jl-vm-cookie-meta">{props.meta}</span> : null}
      {props.blockedReasons.length > 0 ? (
        <span className="jl-vm-cookie-blocked">
          Blocked: {props.blockedReasons.join(", ")}
        </span>
      ) : null}
    </button>
  );
}

function cookieMeta(cookie: {
  domain?: string | undefined;
  path?: string | undefined;
  secure?: boolean | undefined;
  httpOnly?: boolean | undefined;
  sameSite?: string | undefined;
}): string {
  return [
    cookie.domain,
    cookie.path ? `path ${cookie.path}` : null,
    cookie.sameSite ? `SameSite ${cookie.sameSite}` : null,
    cookie.secure ? "Secure" : null,
    cookie.httpOnly ? "HttpOnly" : null
  ]
    .filter(Boolean)
    .join(" · ");
}

type NetworkBody = NonNullable<
  Extract<TimelineItem["payload"], { kind: "network" }>["request"]["body"]
>;

function BodySection(props: {
  title: string;
  body: NetworkBody | undefined;
  onCopy: (value: string, label: string) => void;
}): React.JSX.Element {
  return (
    <div className="jl-vm-drawer-section">
      <span className="jl-vm-drawer-label">{props.title}</span>
      <BodyContent body={props.body} onCopy={props.onCopy} />
    </div>
  );
}

function BodyContent(props: {
  body: NetworkBody | undefined;
  onCopy: (value: string, label: string) => void;
}): React.JSX.Element {
  if (!props.body) return <span className="jl-vm-empty-line">No body</span>;
  if (props.body.disposition !== "captured" || props.body.value === undefined) {
    const reason = props.body.reason ? ` (${props.body.reason})` : "";
    return <span className="jl-vm-empty-line">{`${props.body.disposition}${reason}`}</span>;
  }
  const value = props.body.value;
  const isBase64 = props.body.encoding === "base64";
  const display = isBase64 ? `[base64, ${props.body.byteLength ?? "?"} bytes]` : value;
  return (
    <pre className="jl-vm-pre" onClick={() => props.onCopy(value, "body")}>{display}</pre>
  );
}
