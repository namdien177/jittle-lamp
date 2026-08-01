import {
	type MigrationDiscovery,
	type MigrationHandshakeRequest,
	type MigrationManifestEntry,
	type MigrationRecord,
	migrationDiscoverySchema,
	migrationHandshakeResponseSchema,
} from "@jittle-lamp/shared";

import type { RuntimeConfig } from "../config/runtime";
import { validateMigrationTargetOrigin } from "./migration-security";

export type PeerLinkCredentials = {
	linkId: string;
	apiOrigin: string;
	sessionToken: string;
};

export type MigrationPeerClient = {
	discover(apiOrigin: string): Promise<MigrationDiscovery>;
	handshake(
		apiOrigin: string,
		input: MigrationHandshakeRequest,
	): Promise<{
		linkId: string;
		destinationInstanceId: string;
		destinationOrganizationId: string;
		destinationWebOrigin: string;
		protocolVersion: string;
		sessionToken: string;
	}>;
	openRun(
		link: PeerLinkCredentials,
		input: {
			sourceRunId: string;
			kind: "full" | "delta" | "final";
			manifestHash: string;
			override: boolean;
		},
	): Promise<{ runId: string; verifiedHashes: string[] }>;
	putManifestPage(
		link: PeerLinkCredentials,
		runId: string,
		page: number,
		input: {
			contentHash: string;
			entries: MigrationManifestEntry[];
			isLast: boolean;
		},
	): Promise<void>;
	putRecordPage(
		link: PeerLinkCredentials,
		runId: string,
		page: number,
		input: { contentHash: string; records: MigrationRecord[] },
	): Promise<void>;
	putArtifact(
		link: PeerLinkCredentials,
		runId: string,
		artifactId: string,
		input: {
			body: Uint8Array;
			contentHash: string;
			contentType: string;
			size: number;
		},
	): Promise<void>;
	commit(
		link: PeerLinkCredentials,
		runId: string,
		input: {
			manifestHash: string;
			recordCount: number;
			artifactCount: number;
			totalBytes: number;
		},
	): Promise<{
		status: string;
		receipt?: string;
		errorCode?: string;
		errorMessage?: string;
	}>;
	getRun(
		link: PeerLinkCredentials,
		runId: string,
	): Promise<Record<string, unknown>>;
	finalizeAck(link: PeerLinkCredentials, receipt: string): Promise<void>;
	notifyDiverged(link: PeerLinkCredentials): Promise<void>;
};

const readError = async (response: Response): Promise<string> => {
	const payload = (await response.json().catch(() => null)) as {
		error?: { message?: string };
	} | null;
	return (
		payload?.error?.message ?? `Migration peer returned HTTP ${response.status}`
	);
};

export const createHttpMigrationPeerClient = (
	runtime: RuntimeConfig,
	fetcher: typeof fetch = Bun.fetch,
): MigrationPeerClient => {
	const request = async (
		apiOrigin: string,
		path: string,
		init: RequestInit = {},
		sessionToken?: string,
	): Promise<Response> => {
		const validatedOrigin = await validateMigrationTargetOrigin({
			origin: apiOrigin,
			nodeEnv: runtime.nodeEnv,
			allowPrivateNetworks: true,
		});
		const headers = new Headers(init.headers);
		if (sessionToken) headers.set("authorization", `Migration ${sessionToken}`);
		const response = await fetcher(`${validatedOrigin}${path}`, {
			...init,
			headers,
			redirect: "error",
		});
		if (!response.ok) throw new Error(await readError(response));
		return response;
	};

	const jsonRequest = async <T>(
		apiOrigin: string,
		path: string,
		body?: unknown,
		sessionToken?: string,
		method = "POST",
	): Promise<T> => {
		const response = await request(
			apiOrigin,
			path,
			{
				method,
				...(body === undefined
					? {}
					: {
							headers: { "content-type": "application/json" },
							body: JSON.stringify(body),
						}),
			},
			sessionToken,
		);
		return (await response.json()) as T;
	};

	return {
		discover: async (apiOrigin) =>
			migrationDiscoverySchema.parse(
				await jsonRequest(
					apiOrigin,
					"/.well-known/jittle-lamp-migration",
					undefined,
					undefined,
					"GET",
				),
			),
		handshake: async (apiOrigin, input) =>
			migrationHandshakeResponseSchema.parse(
				await jsonRequest(apiOrigin, "/migrations/v1/handshakes", input),
			),
		openRun: (link, input) =>
			jsonRequest(
				link.apiOrigin,
				`/migrations/v1/imports/${link.linkId}/runs`,
				input,
				link.sessionToken,
			),
		putManifestPage: async (link, runId, page, input) => {
			await jsonRequest(
				link.apiOrigin,
				`/migrations/v1/imports/${link.linkId}/runs/${runId}/manifest/${page}`,
				{ page, ...input },
				link.sessionToken,
				"PUT",
			);
		},
		putRecordPage: async (link, runId, page, input) => {
			await jsonRequest(
				link.apiOrigin,
				`/migrations/v1/imports/${link.linkId}/runs/${runId}/records/${page}`,
				{ page, ...input },
				link.sessionToken,
				"PUT",
			);
		},
		putArtifact: async (link, runId, artifactId, input) => {
			await request(
				link.apiOrigin,
				`/migrations/v1/imports/${link.linkId}/runs/${runId}/artifacts/${encodeURIComponent(artifactId)}`,
				{
					method: "PUT",
					headers: {
						"content-type": input.contentType,
						"content-length": String(input.size),
						"x-content-sha256": input.contentHash,
					},
					body: Uint8Array.from(input.body).buffer,
				},
				link.sessionToken,
			);
		},
		commit: (link, runId, input) =>
			jsonRequest(
				link.apiOrigin,
				`/migrations/v1/imports/${link.linkId}/runs/${runId}/commit`,
				input,
				link.sessionToken,
			),
		getRun: (link, runId) =>
			jsonRequest(
				link.apiOrigin,
				`/migrations/v1/imports/${link.linkId}/runs/${runId}`,
				undefined,
				link.sessionToken,
				"GET",
			),
		finalizeAck: async (link, receipt) => {
			await jsonRequest(
				link.apiOrigin,
				`/migrations/v1/imports/${link.linkId}/finalize-ack`,
				{ receipt },
				link.sessionToken,
			);
		},
		notifyDiverged: async (link) => {
			await jsonRequest(
				link.apiOrigin,
				`/migrations/v1/imports/${link.linkId}/diverged`,
				{},
				link.sessionToken,
			);
		},
	};
};

export const createInMemoryMigrationPeerClient = (input: {
	discovery: () => Promise<MigrationDiscovery> | MigrationDiscovery;
	destination: {
		acceptHandshake(
			request: MigrationHandshakeRequest,
		): ReturnType<MigrationPeerClient["handshake"]>;
		openInboundRun(
			linkId: string,
			token: string,
			request: Parameters<MigrationPeerClient["openRun"]>[1],
		): ReturnType<MigrationPeerClient["openRun"]>;
		putInboundManifestPage(
			linkId: string,
			token: string,
			runId: string,
			page: number,
			request: Parameters<MigrationPeerClient["putManifestPage"]>[3],
		): Promise<void>;
		putInboundRecordPage(
			linkId: string,
			token: string,
			runId: string,
			page: number,
			request: Parameters<MigrationPeerClient["putRecordPage"]>[3],
		): Promise<void>;
		putInboundArtifact(
			linkId: string,
			token: string,
			runId: string,
			artifactId: string,
			request: Parameters<MigrationPeerClient["putArtifact"]>[3],
		): Promise<void>;
		commitInboundRun(
			linkId: string,
			token: string,
			runId: string,
			request: Parameters<MigrationPeerClient["commit"]>[2],
		): ReturnType<MigrationPeerClient["commit"]>;
		getInboundRun(
			linkId: string,
			token: string,
			runId: string,
		): ReturnType<MigrationPeerClient["getRun"]>;
		finalizeInbound(
			linkId: string,
			token: string,
			receipt: string,
		): Promise<void>;
		markInboundDiverged(linkId: string, token: string): Promise<void>;
	};
}): MigrationPeerClient => ({
	discover: async () => input.discovery(),
	handshake: async (_apiOrigin, request) =>
		input.destination.acceptHandshake(request),
	openRun: (link, request) =>
		input.destination.openInboundRun(link.linkId, link.sessionToken, request),
	putManifestPage: (link, runId, page, request) =>
		input.destination.putInboundManifestPage(
			link.linkId,
			link.sessionToken,
			runId,
			page,
			request,
		),
	putRecordPage: (link, runId, page, request) =>
		input.destination.putInboundRecordPage(
			link.linkId,
			link.sessionToken,
			runId,
			page,
			request,
		),
	putArtifact: (link, runId, artifactId, request) =>
		input.destination.putInboundArtifact(
			link.linkId,
			link.sessionToken,
			runId,
			artifactId,
			request,
		),
	commit: (link, runId, request) =>
		input.destination.commitInboundRun(
			link.linkId,
			link.sessionToken,
			runId,
			request,
		),
	getRun: (link, runId) =>
		input.destination.getInboundRun(link.linkId, link.sessionToken, runId),
	finalizeAck: (link, receipt) =>
		input.destination.finalizeInbound(link.linkId, link.sessionToken, receipt),
	notifyDiverged: (link) =>
		input.destination.markInboundDiverged(link.linkId, link.sessionToken),
});
