import { apiOrigin } from "./env";

const aiAccessTokenSecretStoragePrefix = "jittle-lamp.ai-access-token-secret.";

export function cacheAiAccessTokenSecret(tokenId: string, token: string): void {
	try {
		window.localStorage.setItem(
			`${aiAccessTokenSecretStoragePrefix}${tokenId}`,
			token,
		);
	} catch {
		// Clipboard prompt copy can still work for the current one-time token.
	}
}

export function readCachedAiAccessTokenSecret(tokenId: string): string | null {
	try {
		const token = window.localStorage.getItem(
			`${aiAccessTokenSecretStoragePrefix}${tokenId}`,
		);
		return token?.startsWith("jl_ai_") ? token : null;
	} catch {
		return null;
	}
}

export function clearCachedAiAccessTokenSecret(tokenId: string): void {
	try {
		window.localStorage.removeItem(`${aiAccessTokenSecretStoragePrefix}${tokenId}`);
	} catch {
		// Nothing to clear when browser storage is unavailable.
	}
}

export function buildAiEvidencePrompt(token: string): string {
	return `Use Jittle Lamp's AI evidence debugging instructions from ${apiOrigin}/llms.txt.

AI access token:
${token}

When I give you an evidence link or evidence id, use that token as:
Authorization: Bearer ${token}

Fetch the evidence debug information, inspect the session archive, console, network, lifecycle events, and artifacts, then explain what is confirmed by the evidence and what is only a hypothesis.`;
}

export function buildTargetEvidenceLlmPrompt(input: {
	token: string;
	evidenceId: string;
	evidenceUrl: string;
	orgId?: string | null;
	title?: string | null;
}): string {
	const query = input.orgId
		? `?${new URLSearchParams({ orgId: input.orgId }).toString()}`
		: "";
	const debugEndpoint = `${apiOrigin}/ai/evidences/${encodeURIComponent(input.evidenceId)}/debug${query}`;
	const title = input.title?.trim();

	return `Use Jittle Lamp's AI evidence debugging instructions from ${apiOrigin}/llms.txt.

Investigate this target evidence immediately.
${title ? `Evidence title: ${title}\n` : ""}Evidence URL: ${input.evidenceUrl}
Evidence ID: ${input.evidenceId}
Debug endpoint: GET ${debugEndpoint}

AI access token:
${input.token}

Use the token as:
Authorization: Bearer ${input.token}

Fetch the debug endpoint, prefer the session_archive artifact, inspect the session archive, console entries, network entries, lifecycle events, errors, and artifacts, then explain what is confirmed by the evidence and what is only a hypothesis.`;
}
