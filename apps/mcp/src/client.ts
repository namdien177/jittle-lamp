import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { version } from "../package.json";

export type McpConfig = { token: string; apiOrigin: string; webOrigin: string };
export type RequestOptions = {
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
};

function readOrigin(value: string, name: string, allowPath = false): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be an absolute HTTP(S) origin`);
	}
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(!allowPath && url.pathname !== "/")
	) {
		throw new Error(`${name} must be an HTTPS origin, or HTTP on localhost`);
	}
	return allowPath
		? `${url.origin}${url.pathname.replace(/\/+$/, "")}`
		: url.origin;
}

export function readConfig(env: Record<string, string | undefined>): McpConfig {
	const token = env.JL_AI_TOKEN?.trim();
	if (!token || !/^jl_(ai|api)_[A-Za-z0-9_-]{18,}$/.test(token)) {
		throw new Error(
			"JL_AI_TOKEN is required. Configure a Jittle Lamp AI token or automation API token; each tool keeps the token's existing permissions.",
		);
	}
	return {
		token,
		apiOrigin: readOrigin(
			env.JITTLE_LAMP_API_ORIGIN || "https://jl-api.monthlyparty.com",
			"JITTLE_LAMP_API_ORIGIN",
			true,
		),
		webOrigin: readOrigin(
			env.JITTLE_LAMP_WEB_ORIGIN || "https://jittlelamp.dev",
			"JITTLE_LAMP_WEB_ORIGIN",
		),
	};
}

export const toolResult = (
	data: Record<string, unknown>,
	isError = false,
): CallToolResult => ({
	content: [{ type: "text", text: JSON.stringify(data) }],
	structuredContent: data,
	...(isError ? { isError: true } : {}),
});

export class JittleLampClient {
	constructor(
		readonly config: McpConfig,
		private readonly fetcher: typeof fetch = fetch,
	) {}

	async request(
		method: string,
		path: string,
		options: RequestOptions = {},
		binary?: Uint8Array,
		contentType = "application/zip",
	): Promise<CallToolResult> {
		// The tool catalog supplies all paths. Reject origin overrides and URL traversal here too.
		if (
			!path.startsWith("/") ||
			path.startsWith("//") ||
			/[?#\\]|%|(?:^|\/)\.{1,2}(?:\/|$)/.test(path)
		) {
			return toolResult({ error: "Invalid API path" }, true);
		}
		const url = new URL(`${this.config.apiOrigin}${path}`);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		try {
			const response = await this.fetcher(url, {
				method,
				headers: {
					authorization: `Bearer ${this.config.token}`,
					"user-agent": `jittle-lamp-mcp/${version}`,
					...(binary
						? { "content-type": contentType }
						: options.body !== undefined
							? { "content-type": "application/json" }
							: {}),
				},
				...(binary
					? { body: Uint8Array.from(binary).buffer }
					: options.body !== undefined
						? { body: JSON.stringify(options.body) }
						: {}),
				redirect: "error",
				signal: AbortSignal.timeout(binary ? 120_000 : 30_000),
			});
			if (response.status === 204) return toolResult({ status: 204 });
			const permissionGuidance =
				this.config.token.startsWith("jl_api_") &&
				path !== "/automation/evidences/zip" &&
				(response.status === 401 || response.status === 403)
					? {
							tokenGuidance:
								"Jittle Lamp denied this tool. Automation API tokens grant ZIP uploads in their assigned organisation. Other tools require a suitable AI token and account permissions. Invalid, expired, or revoked tokens must be replaced.",
						}
					: {};
			const text = (await response.text()).replaceAll(
				this.config.token,
				"[REDACTED]",
			);
			let data: unknown;
			try {
				data = JSON.parse(text);
			} catch {
				return toolResult(
					{
						error: "Jittle Lamp returned a non-JSON response",
						status: response.status,
						...permissionGuidance,
					},
					true,
				);
			}
			const result =
				data && typeof data === "object" && !Array.isArray(data)
					? (data as Record<string, unknown>)
					: { data };
			return toolResult(
				response.ok
					? result
					: { ...result, status: response.status, ...permissionGuidance },
				!response.ok,
			);
		} catch {
			// Network exceptions can include request headers. Never return their raw text.
			return toolResult(
				{
					error:
						"Jittle Lamp request failed or timed out. Check API connectivity. Before retrying a write, check whether it completed.",
				},
				true,
			);
		}
	}
}
