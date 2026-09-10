import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
	CallToolResult,
	ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type JittleLampRequest = (
	method: string,
	path: string,
	options?: {
		query?: Record<string, string | number | boolean | undefined>;
		body?: unknown;
	},
) => Promise<CallToolResult>;

const identifier = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9_-]+$/, "Use an ID or slug, not a URL or path.");
const orgId = identifier
	.optional()
	.describe("Member organisation ID. Omit to use the active organisation.");
const evidenceId = identifier.describe(
	"Evidence ID from the library or evidence URL.",
);
const evidenceInput = z.strictObject({ evidenceId, orgId });
const emptyInput = z.strictObject({});
const page = z.number().int().min(1).optional();
const limit = z.number().int().min(1).max(100).optional();

const readAnnotations: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
const createAnnotations: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: false,
};
const updateAnnotations: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: false,
};

const artifactKind = z.enum([
	"recording",
	"transcript",
	"screenshot",
	"network-log",
	"attachment",
]);
const artifactFields = {
	mimeType: z.string().min(1).max(200),
	bytes: z.number().int().nonnegative(),
	checksum: z
		.string()
		.min(1)
		.max(200)
		.describe("SHA-256 of the exact uploaded bytes, as hex or sha256:hex."),
};
const uploadFields = {
	title: z.string().trim().min(1).max(200),
	sourceMetadata: z
		.string()
		.optional()
		.describe("JSON metadata encoded as a string."),
	thumbnailBase64: z.string().max(20_000).optional(),
	thumbnailMimeType: z.string().min(1).max(200).optional(),
};

/** All paths and methods are fixed here. Organisation administration has no tools. */
export function registerJittleLampTools(
	server: McpServer,
	request: JittleLampRequest,
): void {
	server.registerTool(
		"get_context",
		{
			description:
				"Get the token owner's profile, active organisation, and member organisations. Permissions remain the owner's current permissions.",
			inputSchema: emptyInput,
			annotations: readAnnotations,
		},
		() => request("GET", "/protected/me"),
	);
	server.registerTool(
		"list_organizations",
		{
			description:
				"List organisations the token owner belongs to, including role and workspace metadata.",
			inputSchema: emptyInput,
			annotations: readAnnotations,
		},
		() => request("GET", "/orgs"),
	);
	server.registerTool(
		"select_organization",
		{
			description:
				"Select a member organisation as the owner's active workspace. This also changes the workspace used by the web app and uploads. Finish pending uploads before switching.",
			inputSchema: z.strictObject({ orgId: identifier }),
			annotations: { ...updateAnnotations, destructiveHint: false },
		},
		({ orgId }) => request("POST", `/orgs/${orgId}/select-active`),
	);
	server.registerTool(
		"list_evidences",
		{
			description:
				"Search the evidence library, newest first. Search matches title, ID, source type, and creator ID. Creator and tag arrays match any listed value. Defaults to page 1 and 24 results.",
			inputSchema: z.strictObject({
				orgId,
				search: z.string().optional(),
				createdBy: z.array(identifier).max(100).optional(),
				tagIds: z.array(identifier).max(100).optional(),
				page,
				limit,
			}),
			annotations: readAnnotations,
		},
		({ createdBy, tagIds, ...query }) =>
			request("GET", "/evidences", {
				query: {
					...query,
					createdBy: createdBy?.join(","),
					tagIds: tagIds?.join(","),
				},
			}),
	);
	server.registerTool(
		"get_evidence",
		{
			description:
				"Get evidence metadata, its recording status, creator profile, and assigned tags.",
			inputSchema: evidenceInput,
			annotations: readAnnotations,
		},
		({ evidenceId, orgId }) =>
			request("GET", `/evidences/${evidenceId}`, { query: { orgId } }),
	);
	server.registerTool(
		"get_evidence_playback",
		{
			description:
				"Get evidence, artifacts, and short-lived download URLs for playback. Requires view and download permissions. URLs expire and can be renewed by calling again.",
			inputSchema: evidenceInput,
			annotations: readAnnotations,
		},
		({ evidenceId, orgId }) =>
			request("GET", `/evidences/${evidenceId}/playback`, { query: { orgId } }),
	);
	server.registerTool(
		"list_evidence_artifacts",
		{
			description:
				"List evidence artifacts with IDs, kinds, MIME types, byte sizes, checksums, and upload status.",
			inputSchema: evidenceInput,
			annotations: readAnnotations,
		},
		({ evidenceId, orgId }) =>
			request("GET", `/evidences/${evidenceId}/artifacts`, {
				query: { orgId },
			}),
	);
	server.registerTool(
		"get_artifact_read_url",
		{
			description:
				"Get a short-lived signed URL to download an uploaded artifact. Fetch this URL without the AI token. Requires evidence download permission.",
			inputSchema: z.strictObject({
				evidenceId,
				artifactId: identifier,
				orgId,
			}),
			annotations: readAnnotations,
		},
		({ evidenceId, artifactId, orgId }) =>
			request(
				"GET",
				`/evidences/${evidenceId}/artifacts/${artifactId}/read-url`,
				{ query: { orgId } },
			),
	);
	server.registerTool(
		"get_evidence_debug",
		{
			description:
				"Get evidence debug context, artifact roles, and optional read URLs. Inspect the session_archive first for recorded actions, console output, network requests, and lifecycle events. Metadata alone does not prove a root cause.",
			inputSchema: z.strictObject({
				evidenceId,
				orgId,
				includeReadUrls: z.boolean().optional(),
			}),
			annotations: readAnnotations,
		},
		({ evidenceId, ...query }) =>
			request("GET", `/ai/evidences/${evidenceId}/debug`, { query }),
	);
	server.registerTool(
		"rename_evidence",
		{
			description:
				"Rename evidence. Requires permission to update the owner's evidence or any evidence in its organisation.",
			inputSchema: z.strictObject({
				evidenceId,
				title: z.string().trim().min(1).max(200),
			}),
			annotations: updateAnnotations,
		},
		({ evidenceId, title }) =>
			request("PATCH", `/evidences/${evidenceId}`, { body: { title } }),
	);
	server.registerTool(
		"delete_evidence",
		{
			description:
				"Move evidence to the bin. It is automatically purged after 30 days. Requires permission to delete this evidence.",
			inputSchema: z.strictObject({ evidenceId }),
			annotations: updateAnnotations,
		},
		({ evidenceId }) => request("DELETE", `/evidences/${evidenceId}`),
	);
	server.registerTool(
		"bulk_delete_evidences",
		{
			description:
				"Move up to 100 evidences to the bin for automatic purge after 30 days. The owner must have permission to delete every selected evidence.",
			inputSchema: z.strictObject({
				evidenceIds: z.array(identifier).min(1).max(100),
			}),
			annotations: updateAnnotations,
		},
		({ evidenceIds }) =>
			request("POST", "/evidences/bulk-delete", { body: { ids: evidenceIds } }),
	);
	server.registerTool(
		"copy_evidence",
		{
			description:
				"Copy evidence into another member organisation. Requires source view permission and target create permission. Returns a new evidence ID.",
			inputSchema: z.strictObject({ evidenceId, targetOrgId: identifier }),
			annotations: createAnnotations,
		},
		({ evidenceId, targetOrgId }) =>
			request("POST", `/evidences/${evidenceId}/copy`, {
				body: { targetOrgId },
			}),
	);
	server.registerTool(
		"move_evidence",
		{
			description:
				"Transfer evidence to another member organisation and invalidate its existing share links. Requires source move permission and target create permission.",
			inputSchema: z.strictObject({ evidenceId, targetOrgId: identifier }),
			annotations: updateAnnotations,
		},
		({ evidenceId, targetOrgId }) =>
			request("POST", `/evidences/${evidenceId}/move`, {
				body: { targetOrgId },
			}),
	);
	server.registerTool(
		"list_evidence_comments",
		{
			description:
				"Read comments on evidence in creation order, with author labels and timestamps.",
			inputSchema: evidenceInput,
			annotations: readAnnotations,
		},
		({ evidenceId, orgId }) =>
			request("GET", `/evidences/${evidenceId}/comments`, { query: { orgId } }),
	);
	server.registerTool(
		"create_evidence_comment",
		{
			description:
				"Post a comment on evidence as the token owner. Requires evidence comment permission. Repeating this tool posts another comment.",
			inputSchema: z.strictObject({
				evidenceId,
				orgId,
				body: z.string().trim().min(1).max(4000),
			}),
			annotations: createAnnotations,
		},
		({ evidenceId, orgId, body }) =>
			request("POST", `/evidences/${evidenceId}/comments`, {
				query: { orgId },
				body: { body },
			}),
	);
	server.registerTool(
		"list_evidence_tags",
		{
			description:
				"List existing organisation evidence tags for filtering or assignment. Tag definitions are managed by humans in organisation settings.",
			inputSchema: z.strictObject({ orgId }),
			annotations: readAnnotations,
		},
		(query) => request("GET", "/evidences/tags", { query }),
	);
	server.registerTool(
		"set_evidence_tags",
		{
			description:
				"Replace the evidence's assigned tags with up to 20 existing tag IDs. An empty list removes all assignments. Requires evidence tag management permission.",
			inputSchema: z.strictObject({
				evidenceId,
				tagIds: z.array(identifier).max(20),
			}),
			annotations: updateAnnotations,
		},
		({ evidenceId, tagIds }) =>
			request("PATCH", `/evidences/${evidenceId}/tags`, { body: { tagIds } }),
	);
	server.registerTool(
		"list_share_links",
		{
			description:
				"List evidence share links, including expiry and revocation status. Share links require organisation membership to open.",
			inputSchema: z.strictObject({ evidenceId }),
			annotations: readAnnotations,
		},
		({ evidenceId }) => request("GET", `/evidences/${evidenceId}/share-links`),
	);
	server.registerTool(
		"create_share_link",
		{
			description:
				"Create an internal evidence share link. Requires download permission. Omit expiresInMs or use 0 for a permanent link. Opening the link still requires organisation membership.",
			inputSchema: z.strictObject({
				evidenceId,
				expiresInMs: z.number().int().min(0).max(31_536_000_000).optional(),
			}),
			annotations: createAnnotations,
		},
		({ evidenceId, ...body }) =>
			request("POST", `/evidences/${evidenceId}/share-links`, { body }),
	);
	server.registerTool(
		"revoke_share_link",
		{
			description:
				"Revoke an evidence share link so it can no longer be used. Requires download permission for its evidence.",
			inputSchema: z.strictObject({ shareLinkId: identifier }),
			annotations: updateAnnotations,
		},
		({ shareLinkId }) => request("POST", `/share-links/${shareLinkId}/revoke`),
	);
	server.registerTool(
		"resolve_share_link",
		{
			description:
				"Resolve a share slug or legacy share token to its evidence and organisation, and check whether the token owner can access it. Supply the locator only, not a full URL.",
			inputSchema: z.strictObject({ locator: identifier }),
			annotations: readAnnotations,
		},
		({ locator }) => request("GET", `/share-links/${locator}/resolve`),
	);
	server.registerTool(
		"start_manual_upload",
		{
			description:
				"Create evidence in the active organisation from a recording and session archive. Returns two authenticated backend PUT URLs valid for 5 minutes. Upload each file's exact bytes to its URL with the configured AI Bearer token and returned Content-Type, then call complete_upload for each. Recording limit is 60 MB. Keep the active organisation unchanged through completion.",
			inputSchema: z.strictObject({
				...uploadFields,
				sessionId: z.string().min(1).max(200),
				artifacts: z
					.array(
						z.discriminatedUnion("key", [
							z.strictObject({
								key: z.literal("recording"),
								kind: z.literal("recording"),
								...artifactFields,
								bytes: z
									.number()
									.int()
									.min(0)
									.max(60 * 1024 * 1024),
							}),
							z.strictObject({
								key: z.literal("archive"),
								kind: z.literal("network-log"),
								...artifactFields,
							}),
						]),
					)
					.length(2)
					.refine(
						(artifacts) =>
							new Set(artifacts.map((artifact) => artifact.key)).size === 2,
						"Include one recording and one archive.",
					),
			}),
			annotations: createAnnotations,
		},
		(body) => request("POST", "/evidences/manual-uploads/start", { body }),
	);
	server.registerTool(
		"start_upload",
		{
			description:
				"Create evidence with a single artifact in the active organisation. Returns an authenticated backend PUT URL valid for 5 minutes. Upload exact binary bytes with the configured AI Bearer token and returned Content-Type, then call complete_upload. Use start_manual_upload for a recording plus session archive.",
			inputSchema: z.strictObject({
				...uploadFields,
				sourceType: z.string().min(1).max(200),
				sourceUri: z.url().optional(),
				sourceExternalId: z.string().min(1).max(200).optional(),
				artifact: z.strictObject({ kind: artifactKind, ...artifactFields }),
			}),
			annotations: createAnnotations,
		},
		(body) => request("POST", "/evidences/uploads/start", { body }),
	);
	server.registerTool(
		"complete_upload",
		{
			description:
				"Commit an artifact after uploading its bytes to the returned PUT URL. Supply the original byte count, SHA-256 checksum, and MIME type. Keep the same active organisation. Do not retry a completed upload without checking its artifact status.",
			inputSchema: z.strictObject({ uploadId: identifier, ...artifactFields }),
			annotations: { ...createAnnotations, idempotentHint: true },
		},
		({ uploadId, ...body }) =>
			request("POST", `/evidences/uploads/${uploadId}/complete`, { body }),
	);
}
