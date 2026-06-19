import { apiOrigin } from "./env";

const aiAccessTokenSecretStoragePrefix = "jittle-lamp.ai-access-token-secret.";
const aiAccessTokenSecretMemoryCache = new Map<string, string>();

type AiAccessTokenCacheSummary = {
	id: string;
	createdAt: number;
	expiresAt: number | null;
	revokedAt: number | null;
};

function isActiveAiAccessToken(
	token: AiAccessTokenCacheSummary,
	now = Date.now(),
): boolean {
	return token.revokedAt === null && (token.expiresAt === null || token.expiresAt > now);
}

export function cacheAiAccessTokenSecret(tokenId: string, token: string): void {
	aiAccessTokenSecretMemoryCache.set(tokenId, token);
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
	const memoryToken = aiAccessTokenSecretMemoryCache.get(tokenId);
	if (memoryToken?.startsWith("jl_ai_")) return memoryToken;
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
	aiAccessTokenSecretMemoryCache.delete(tokenId);
	try {
		window.localStorage.removeItem(`${aiAccessTokenSecretStoragePrefix}${tokenId}`);
	} catch {
		// Nothing to clear when browser storage is unavailable.
	}
}

export function clearCachedInactiveAiAccessTokenSecrets(
	tokens: AiAccessTokenCacheSummary[],
	now = Date.now(),
): void {
	for (const token of tokens) {
		if (!isActiveAiAccessToken(token, now)) {
			clearCachedAiAccessTokenSecret(token.id);
		}
	}
}

export function readCachedActivePermanentAiAccessTokenSecret(
	tokens: AiAccessTokenCacheSummary[],
	now = Date.now(),
): string | null {
	const activePermanentTokens = tokens
		.filter((token) => token.expiresAt === null && isActiveAiAccessToken(token, now))
		.sort((left, right) => right.createdAt - left.createdAt);

	for (const token of activePermanentTokens) {
		const cachedSecret = readCachedAiAccessTokenSecret(token.id);
		if (cachedSecret) return cachedSecret;
	}

	return null;
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
