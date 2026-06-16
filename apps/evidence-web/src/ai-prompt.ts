import { apiOrigin } from "./env";

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
