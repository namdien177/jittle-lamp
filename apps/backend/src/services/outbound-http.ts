import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { parseBooleanFlag } from "../config/runtime";

// Outbound HTTP to addresses an organisation configures (webhook callbacks, GitHub/GitLab API,
// Slack and webhook notification channels). Guards against SSRF:
//   - http(s) only;
//   - the host is resolved first and every address must be public: loopback, link-local,
//     private (RFC 1918), CGNAT, ULA, multicast and unspecified addresses are refused;
//   - redirects are never followed (`redirect: "manual"`), so credentials are never forwarded to
//     another origin.
// Loopback is allowed only when `allowLoopback` is set (tests and local development with an
// explicit flag). Hosts in `allowHosts` (JL_OUTBOUND_ALLOW_HOSTS, e.g. a self-managed GitLab on
// the internal network) skip the address check. The check resolves before the request, so a
// DNS answer that changes between the two is not covered; run the API behind an egress proxy to
// close that gap.

export class OutboundBlockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OutboundBlockedError";
	}
}

export type OutboundPolicy = {
	allowLoopback: boolean;
	allowHosts: readonly string[];
	lookup?: (host: string) => Promise<string[]>;
};

export const defaultOutboundPolicy: OutboundPolicy = {
	allowLoopback: false,
	allowHosts: [],
};

const ipv4Parts = (address: string): number[] | null => {
	const parts = address.split(".").map((part) => Number(part));
	return parts.length === 4 &&
		parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
		? parts
		: null;
};

export const isLoopbackAddress = (address: string): boolean => {
	const v4 = ipv4Parts(address);
	if (v4) return v4[0] === 127;
	const lower = address.toLowerCase();
	if (lower === "::1") return true;
	const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	return mapped?.[1] ? isLoopbackAddress(mapped[1]) : false;
};

// Addresses an outbound request must not reach.
export const isNonPublicAddress = (address: string): boolean => {
	const v4 = ipv4Parts(address);
	if (v4) {
		const [a = 0, b = 0] = v4;
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 192 && b === 0) ||
			(a === 198 && (b === 18 || b === 19)) ||
			a >= 224
		);
	}
	const lower = address.toLowerCase();
	if (lower === "::" || lower === "::1") return true;
	const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped?.[1]) return isNonPublicAddress(mapped[1]);
	const first = Number.parseInt(lower.split(":")[0] || "0", 16);
	return (
		(first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
		(first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
		(first & 0xff00) === 0xff00 // multicast
	);
};

const resolve = async (policy: OutboundPolicy, host: string) => {
	if (isIP(host)) return [host];
	if (policy.lookup) return policy.lookup(host);
	return (await dnsLookup(host, { all: true, verbatim: true })).map(
		(entry) => entry.address,
	);
};

// Throws OutboundBlockedError unless every address of the URL's host is allowed.
export const assertOutboundUrl = async (
	policy: OutboundPolicy,
	raw: string,
): Promise<URL> => {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new OutboundBlockedError("not a URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new OutboundBlockedError("only http(s) URLs are allowed");
	}
	if (url.username || url.password) {
		throw new OutboundBlockedError("URLs with credentials are not allowed");
	}
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (policy.allowHosts.some((allowed) => allowed.toLowerCase() === host)) {
		return url;
	}
	let addresses: string[];
	try {
		addresses = await resolve(policy, host);
	} catch {
		throw new OutboundBlockedError(`host ${host} does not resolve`);
	}
	if (addresses.length === 0) {
		throw new OutboundBlockedError(`host ${host} does not resolve`);
	}
	for (const address of addresses) {
		if (policy.allowLoopback && isLoopbackAddress(address)) continue;
		if (isNonPublicAddress(address)) {
			throw new OutboundBlockedError(
				`host ${host} resolves to a private or local address`,
			);
		}
	}
	return url;
};

// fetch() behind the address check, without following redirects.
export const guardedFetch = async (
	fetchImpl: typeof fetch,
	policy: OutboundPolicy,
	raw: string,
	init: RequestInit,
): Promise<Response> => {
	const url = await assertOutboundUrl(policy, raw);
	const response = await fetchImpl(url.toString(), {
		...init,
		redirect: "manual",
	});
	if (response.status >= 300 && response.status < 400) {
		throw new OutboundBlockedError(
			`${url.host} answered with a redirect (${response.status}); redirects are not followed`,
		);
	}
	return response;
};

export const outboundPolicyFromEnv = (input: {
	nodeEnv: string;
	allowLoopbackFlag: string | undefined;
	allowHosts: string | undefined;
}): OutboundPolicy => ({
	// Same boolean parsing as RUN_DB_MIGRATIONS and the other flags: 1, true, yes, on.
	allowLoopback:
		input.nodeEnv === "test" || parseBooleanFlag(input.allowLoopbackFlag),
	allowHosts: (input.allowHosts ?? "")
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter((host) => host.length > 0),
});
