import {
	AlertTriangle,
	Bot,
	Building2,
	CalendarClock,
	Check,
	Copy,
	ExternalLink,
	FileArchive,
	KeyRound,
	Plus,
	ShieldCheck,
	Terminal,
	Trash2,
	UploadCloud,
	UserCog,
} from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { Link, NavLink, Outlet } from "react-router";

import {
	buildAiEvidencePrompt,
	cacheAiAccessTokenSecret,
	clearCachedAiAccessTokenSecret,
} from "../ai-prompt";
import type { ApiAiAccessToken, ApiAutomationApiToken } from "../api";
import { useClerk } from "../auth";
import { PageBody, PageHeader } from "../components/page";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/misc";
import { apiOrigin } from "../env";
import { cn } from "../lib/cn";
import {
	useAccountProfile,
	useAiAccessTokens,
	useAutomationApiTokens,
	useCreateAiAccessToken,
	useCreateAutomationApiToken,
	useRevokeAiAccessToken,
	useRevokeAutomationApiToken,
} from "../queries";
import { useToast } from "../toast";
import { copyToClipboard } from "../utils";

const INSTALL_COMMAND =
	"curl -fsSL https://raw.githubusercontent.com/namdien177/jittle-lamp/main/scripts/release/install-macos-desktop.sh | bash";

const DEFAULT_AI_TOKEN_LABEL = "AI evidence debugger";
const DEFAULT_AI_TOKEN_EXPIRY_DAYS = "90";
const DEFAULT_API_TOKEN_LABEL = "Automation evidence uploader";
const DEFAULT_API_TOKEN_EXPIRY_DAYS = "365";

type TokenBase = {
	id: string;
	label: string;
	token: string | null;
	tokenPrefix: string;
	scopes: string[];
	createdAt: number;
	expiresAt: number | null;
	lastUsedAt: number | null;
	revokedAt: number | null;
};

function formatDateTime(value: number | null, fallback = "Never"): string {
	if (!value) return fallback;
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

function formatExpiry(value: number | null): string {
	if (!value) return "Permanent";
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

function formatTokenPrefix(prefix: string): string {
	return `${prefix}...`;
}

function activeTokens<T extends TokenBase>(tokens: T[]): T[] {
	const now = Date.now();
	return tokens.filter(
		(token) =>
			token.revokedAt === null &&
			(token.expiresAt === null || token.expiresAt > now),
	);
}

function SettingCard(props: {
	title: string;
	description?: string;
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<Card className="p-0">
			<div className="border-b border-border px-5 py-4">
				<h2 className="text-base font-semibold">{props.title}</h2>
				{props.description ? (
					<p className="text-base text-muted-foreground">{props.description}</p>
				) : null}
			</div>
			<CardContent className="p-5 pt-5">{props.children}</CardContent>
		</Card>
	);
}

function SettingsSectionNav(): React.JSX.Element {
	const tabs = [
		{ to: "/settings", label: "Overview", icon: UserCog },
		{ to: "/settings/ai-tokens", label: "AI tokens", icon: Bot },
		{ to: "/settings/api-tokens", label: "API tokens", icon: UploadCloud },
	];

	return (
		<nav
			aria-label="Settings"
			className="rounded-lg border border-border bg-card p-2"
		>
			<div className="mb-2 px-2 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
				Settings
			</div>
			<div className="grid gap-1">
				{tabs.map((tab) => {
					const Icon = tab.icon;
					return (
						<NavLink
							key={tab.to}
							to={tab.to}
							end={tab.to === "/settings"}
							className={({ isActive }) =>
								cn(
									"flex items-center gap-2 rounded-md px-3 py-2 text-base font-medium text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground",
									isActive && "bg-secondary text-foreground",
								)
							}
						>
							<Icon className="size-4" aria-hidden />
							<span>{tab.label}</span>
						</NavLink>
					);
				})}
			</div>
		</nav>
	);
}

function TokenWarning(props: { children: React.ReactNode }): React.JSX.Element {
	return (
		<div className="flex gap-3 rounded-lg border border-warning/35 bg-warning/10 p-3 text-base text-muted-foreground">
			<AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
			<p>{props.children}</p>
		</div>
	);
}

function TokenStatusBadge(props: { token: TokenBase }): React.JSX.Element {
	const expired =
		props.token.expiresAt !== null && props.token.expiresAt <= Date.now();
	if (props.token.revokedAt) return <Badge variant="muted">Revoked</Badge>;
	if (expired) return <Badge variant="muted">Expired</Badge>;
	if (props.token.lastUsedAt) return <Badge variant="success">Used</Badge>;
	return <Badge variant="outline">New</Badge>;
}

function CreatedTokenPanel(props: {
	token: string;
	copyLabel: string;
	copied: boolean;
	onCopy: () => void;
	extraAction?: React.ReactNode;
	children: React.ReactNode;
}): React.JSX.Element {
	return (
		<div className="rounded-lg border border-primary/30 bg-primary/10 p-3">
			<div className="mb-2 flex items-center gap-2 text-base font-semibold text-foreground">
				<ShieldCheck className="size-4 text-primary" aria-hidden />
				New token is ready
			</div>
			<p className="mb-2 text-base text-muted-foreground">{props.children}</p>
			<div className="flex items-center gap-2 overflow-hidden rounded-md border border-border bg-black/30 pl-3 pr-1.5 font-mono text-base">
				<code className="flex-1 truncate py-2.5 text-muted-foreground">
					{props.token}
				</code>
				<div className="my-1 flex shrink-0 items-center gap-1">
					{props.extraAction}
					<button
						type="button"
						onClick={props.onCopy}
						className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 font-medium text-foreground transition-colors hover:bg-white/[0.08]"
					>
						{props.copied ? (
							<Check className="size-3.5 text-primary" aria-hidden />
						) : (
							<Copy className="size-3.5" aria-hidden />
						)}
						{props.copied ? "Copied" : props.copyLabel}
					</button>
				</div>
			</div>
		</div>
	);
}

function TokenSecret(props: {
	token: TokenBase;
	onCopy: () => void;
}): React.JSX.Element {
	const value = props.token.token ?? formatTokenPrefix(props.token.tokenPrefix);
	return (
		<span
			className="inline-flex min-w-0 items-center gap-1.5 font-mono"
			title={value}
		>
			<KeyRound className="size-3.5" aria-hidden />
			<span className="break-all">{value}</span>
			<Button
				variant="ghost"
				size="icon-sm"
				className="size-7"
				disabled={!props.token.token}
				onClick={props.onCopy}
				aria-label={`Copy ${props.token.label}`}
			>
				<Copy aria-hidden />
			</Button>
		</span>
	);
}

export function SettingsPage(): React.JSX.Element {
	return (
		<>
			<PageHeader eyebrow="Workspace" title="Settings" />
			<PageBody className="max-w-5xl">
				<div className="grid gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
					<aside className="lg:sticky lg:top-6 lg:self-start">
						<SettingsSectionNav />
					</aside>
					<div className="min-w-0">
						<Outlet />
					</div>
				</div>
			</PageBody>
		</>
	);
}

export function SettingsOverviewPage(): React.JSX.Element {
	const clerk = useClerk();
	const profileQuery = useAccountProfile();
	const profile = profileQuery.data ?? null;
	const activeOrg = profile?.organizations.find((org) => org.isActive) ?? null;
	const [copied, setCopied] = useState(false);

	const initials = (profile?.user.displayName ?? profile?.user.email ?? "?")
		.split(" ")
		.map((part) => part[0])
		.filter(Boolean)
		.slice(0, 2)
		.join("")
		.toUpperCase();

	const onCopy = (): void => {
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1800);
		void copyToClipboard(INSTALL_COMMAND).catch(() => undefined);
	};

	return (
		<div className="grid gap-4">
			<SettingCard title="Account">
				{profileQuery.isPending ? (
					<Skeleton className="h-12 w-full" />
				) : (
					<div className="flex items-center gap-3">
						{profile?.user.imageUrl ? (
							<img
								src={profile.user.imageUrl}
								alt=""
								className="size-11 rounded-lg border border-border object-cover"
							/>
						) : (
							<span className="grid size-11 place-items-center rounded-lg border border-border bg-secondary text-base font-semibold">
								{initials}
							</span>
						)}
						<div className="min-w-0 flex-1">
							<p className="truncate text-base font-semibold text-foreground">
								{profile?.user.displayName ?? "Signed in"}
							</p>
							<p className="truncate text-base text-muted-foreground">
								{profile?.user.email ?? "-"}
							</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={() => clerk.openUserProfile()}
						>
							<UserCog aria-hidden />
							Manage account
						</Button>
					</div>
				)}
			</SettingCard>

			<SettingCard title="Active workspace" description="Upload target.">
				<div className="flex items-center gap-3">
					<span className="grid size-11 place-items-center rounded-lg border border-border bg-secondary text-primary">
						<Building2 className="size-5" aria-hidden />
					</span>
					<div className="min-w-0 flex-1">
						<p className="truncate text-base font-semibold text-foreground">
							{activeOrg?.name ?? "No active workspace"}
						</p>
						<p className="text-base text-muted-foreground">
							{profile
								? `${profile.organizations.length} organisation${profile.organizations.length === 1 ? "" : "s"}`
								: "-"}
						</p>
					</div>
					{activeOrg ? <Badge variant="brand">{activeOrg.role}</Badge> : null}
					<Link
						to="/organisations"
						className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}
					>
						Switch
					</Link>
				</div>
			</SettingCard>

			<SettingCard
				title="Desktop companion"
				description="Local capture bridge."
			>
				<div className="flex items-center gap-2 overflow-hidden rounded-lg border border-border bg-black/30 pl-3 pr-1.5 font-mono text-base">
					<Terminal aria-hidden className="size-4 shrink-0 text-primary" />
					<code
						className="flex-1 truncate py-2.5 text-muted-foreground"
						title={INSTALL_COMMAND}
					>
						curl ... | bash
					</code>
					<button
						type="button"
						onClick={onCopy}
						className="my-1 inline-flex shrink-0 items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 font-medium text-foreground transition-colors hover:bg-white/[0.08]"
					>
						{copied ? (
							<Check className="size-3.5 text-primary" aria-hidden />
						) : (
							<Copy className="size-3.5" aria-hidden />
						)}
						{copied ? "Copied" : "Copy"}
					</button>
				</div>
				<a
					href="https://chromewebstore.google.com/detail/ddllejobfkkbmijlflllnnfihfbmhmfh"
					target="_blank"
					rel="noreferrer"
					className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "mt-3")}
				>
					Get the browser extension
					<ExternalLink aria-hidden />
				</a>
			</SettingCard>
		</div>
	);
}

export function SettingsAiTokensPage(): React.JSX.Element {
	const toast = useToast();
	const aiTokensQuery = useAiAccessTokens();
	const createAiToken = useCreateAiAccessToken();
	const revokeAiToken = useRevokeAiAccessToken();
	const [copiedAiToken, setCopiedAiToken] = useState(false);
	const [copiedAiPrompt, setCopiedAiPrompt] = useState(false);
	const [aiTokenLabel, setAiTokenLabel] = useState(DEFAULT_AI_TOKEN_LABEL);
	const [aiTokenExpiryDays, setAiTokenExpiryDays] = useState(
		DEFAULT_AI_TOKEN_EXPIRY_DAYS,
	);
	const [aiTokenPermanent, setAiTokenPermanent] = useState(false);
	const [createdAiToken, setCreatedAiToken] = useState<{
		id: string;
		token: string;
	} | null>(null);
	const [tokenToRevoke, setTokenToRevoke] = useState<ApiAiAccessToken | null>(
		null,
	);

	const aiTokens = activeTokens(aiTokensQuery.data?.accessTokens ?? []);

	const onCopyAiToken = (): void => {
		if (!createdAiToken) return;
		setCopiedAiToken(true);
		window.setTimeout(() => setCopiedAiToken(false), 1800);
		void copyToClipboard(createdAiToken.token)
			.then(() => toast.success("AI token copied"))
			.catch((error) =>
				toast.error(
					"Unable to copy AI token",
					error instanceof Error ? error.message : undefined,
				),
			);
	};

	const onCopyAiPrompt = (): void => {
		if (!createdAiToken) return;
		setCopiedAiPrompt(true);
		window.setTimeout(() => setCopiedAiPrompt(false), 1800);
		void copyToClipboard(buildAiEvidencePrompt(createdAiToken.token))
			.then(() => toast.success("AI prompt copied"))
			.catch((error) =>
				toast.error(
					"Unable to copy AI prompt",
					error instanceof Error ? error.message : undefined,
				),
			);
	};

	const onCopyListedAiToken = (token: ApiAiAccessToken): void => {
		if (!token.token) {
			toast.error(
				"Token secret is not available",
				"Create a new token to show it here.",
			);
			return;
		}
		void copyToClipboard(token.token)
			.then(() => toast.success("AI token copied"))
			.catch((error) =>
				toast.error(
					"Unable to copy AI token",
					error instanceof Error ? error.message : undefined,
				),
			);
	};

	const onCreateAiToken = (event: React.FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		const trimmedLabel = aiTokenLabel.trim() || DEFAULT_AI_TOKEN_LABEL;
		const parsedDays = Number.parseInt(aiTokenExpiryDays, 10);
		const expiresInDays = Number.isFinite(parsedDays)
			? Math.min(365, Math.max(1, parsedDays))
			: 90;

		createAiToken.mutate(
			{
				label: trimmedLabel,
				permanent: aiTokenPermanent,
				...(aiTokenPermanent ? {} : { expiresInDays }),
			},
			{
				onSuccess: (payload) => {
					setAiTokenLabel(DEFAULT_AI_TOKEN_LABEL);
					setAiTokenExpiryDays(DEFAULT_AI_TOKEN_EXPIRY_DAYS);
					setAiTokenPermanent(false);
					setCreatedAiToken({
						id: payload.accessToken.id,
						token: payload.token,
					});
					if (payload.accessToken.expiresAt === null) {
						cacheAiAccessTokenSecret(payload.accessToken.id, payload.token);
					}
					setCopiedAiToken(false);
					setCopiedAiPrompt(false);
					toast.success("AI token created");
				},
				onError: (error) => {
					toast.error(
						"Unable to create AI token",
						error instanceof Error ? error.message : undefined,
					);
				},
			},
		);
	};

	const onConfirmRevokeAiToken = (): void => {
		if (!tokenToRevoke) return;
		revokeAiToken.mutate(tokenToRevoke.id, {
			onSuccess: () => {
				toast.success("AI token revoked");
				clearCachedAiAccessTokenSecret(tokenToRevoke.id);
				if (createdAiToken?.id === tokenToRevoke.id) {
					setCreatedAiToken(null);
					setCopiedAiToken(false);
					setCopiedAiPrompt(false);
				}
				setTokenToRevoke(null);
			},
			onError: (error) => {
				toast.error(
					"Unable to revoke AI token",
					error instanceof Error ? error.message : undefined,
				);
			},
		});
	};

	return (
		<>
			<SettingCard
				title="AI access tokens"
				description="Use with LLM evidence debug tools."
			>
				<div className="flex flex-col gap-5">
					<TokenWarning>
						An LLM or user with this token can load the evidence session and
						inspect captured request data.
					</TokenWarning>

					<form
						className="grid gap-3 md:grid-cols-[minmax(0,1fr)_8rem_auto]"
						onSubmit={onCreateAiToken}
					>
						<Field label="Label" htmlFor="ai-token-label">
							<Input
								id="ai-token-label"
								value={aiTokenLabel}
								onChange={(event) => setAiTokenLabel(event.target.value)}
								placeholder={DEFAULT_AI_TOKEN_LABEL}
								disabled={createAiToken.isPending}
							/>
						</Field>
						<Field label="Days" htmlFor="ai-token-expiry">
							<Input
								id="ai-token-expiry"
								type="number"
								min={1}
								max={365}
								value={aiTokenExpiryDays}
								onChange={(event) => setAiTokenExpiryDays(event.target.value)}
								disabled={createAiToken.isPending || aiTokenPermanent}
							/>
						</Field>
						<div className="flex items-end">
							<Button
								type="submit"
								size="md"
								className="w-full md:w-auto"
								disabled={createAiToken.isPending}
							>
								<Plus aria-hidden />
								{createAiToken.isPending ? "Creating..." : "Create token"}
							</Button>
						</div>
						<label className="flex items-center gap-2 text-base text-muted-foreground md:col-span-3">
							<input
								type="checkbox"
								className="size-4 accent-primary"
								checked={aiTokenPermanent}
								disabled={createAiToken.isPending}
								onChange={(event) =>
									setAiTokenPermanent(event.currentTarget.checked)
								}
							/>
							Permanent token
						</label>
					</form>

					{createdAiToken ? (
						<CreatedTokenPanel
							token={createdAiToken.token}
							copyLabel="Copy token"
							copied={copiedAiToken}
							onCopy={onCopyAiToken}
							extraAction={
								<button
									type="button"
									onClick={onCopyAiPrompt}
									className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 font-medium text-primary-foreground transition-colors hover:bg-primary/90"
								>
									{copiedAiPrompt ? (
										<Check className="size-3.5" aria-hidden />
									) : (
										<Copy className="size-3.5" aria-hidden />
									)}
									{copiedAiPrompt ? "Copied prompt" : "Copy prompt"}
								</button>
							}
						>
							This token stays visible here. Keep it only where evidence access is
							allowed.
						</CreatedTokenPanel>
					) : null}

					<div className="overflow-hidden rounded-lg border border-border">
						{aiTokensQuery.isPending ? (
							<div className="space-y-2 p-3">
								<Skeleton className="h-12 w-full" />
								<Skeleton className="h-12 w-full" />
							</div>
						) : aiTokens.length === 0 ? (
							<div className="flex items-center gap-3 p-4 text-base text-muted-foreground">
								<span className="grid size-10 place-items-center rounded-lg border border-border bg-secondary">
									<KeyRound className="size-4" aria-hidden />
								</span>
								No AI tokens yet
							</div>
						) : (
							<div className="divide-y divide-border">
								{aiTokens.map((token) => (
									<div
										key={token.id}
										className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_auto]"
									>
										<div className="min-w-0">
											<div className="flex flex-wrap items-center gap-2">
												<p className="truncate text-base font-semibold text-foreground">
													{token.label}
												</p>
												<TokenStatusBadge token={token} />
												<Badge variant="outline">{token.tokenVersion}</Badge>
											</div>
											<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-base text-muted-foreground">
												<TokenSecret
													token={token}
													onCopy={() => onCopyListedAiToken(token)}
												/>
												<span className="inline-flex items-center gap-1.5">
													<CalendarClock className="size-3.5" aria-hidden />
													Expires {formatExpiry(token.expiresAt)}
												</span>
												<span>Last used {formatDateTime(token.lastUsedAt)}</span>
											</div>
											<p className="mt-2 text-base text-muted-foreground">
												Can fetch evidence sessions for LLM debugging.
											</p>
										</div>
										<div className="flex items-center justify-end gap-2">
											<Button
												variant="destructive"
												size="sm"
												disabled={token.revokedAt !== null || revokeAiToken.isPending}
												onClick={() => setTokenToRevoke(token)}
											>
												<Trash2 aria-hidden />
												Revoke
											</Button>
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				</div>
			</SettingCard>
			<ConfirmDialog
				open={Boolean(tokenToRevoke)}
				title="Revoke AI token"
				description={
					tokenToRevoke
						? `${tokenToRevoke.label} will stop working immediately.`
						: undefined
				}
				confirmLabel="Revoke"
				destructive
				busy={revokeAiToken.isPending}
				onConfirm={onConfirmRevokeAiToken}
				onCancel={() => setTokenToRevoke(null)}
			/>
		</>
	);
}

function buildAutomationUploadCurl(token: string): string {
	return [
		`curl -X POST "${apiOrigin}/automation/evidences/zip?title=My%20automation%20run"`,
		`  -H "Authorization: Bearer ${token}"`,
		'  -H "Content-Type: application/zip"',
		"  --data-binary @evidence.zip",
	].join(" \\\n");
}

export function SettingsApiTokensPage(): React.JSX.Element {
	const toast = useToast();
	const profileQuery = useAccountProfile();
	const apiTokensQuery = useAutomationApiTokens();
	const createApiToken = useCreateAutomationApiToken();
	const revokeApiToken = useRevokeAutomationApiToken();
	const [apiTokenLabel, setApiTokenLabel] = useState(DEFAULT_API_TOKEN_LABEL);
	const [apiTokenExpiryDays, setApiTokenExpiryDays] = useState(
		DEFAULT_API_TOKEN_EXPIRY_DAYS,
	);
	const [apiTokenPermanent, setApiTokenPermanent] = useState(false);
	const [copiedApiToken, setCopiedApiToken] = useState(false);
	const [copiedCurl, setCopiedCurl] = useState(false);
	const [createdApiToken, setCreatedApiToken] = useState<{
		id: string;
		token: string;
	} | null>(null);
	const [tokenToRevoke, setTokenToRevoke] =
		useState<ApiAutomationApiToken | null>(null);

	const profile = profileQuery.data ?? null;
	const activeOrg = profile?.organizations.find((org) => org.isActive) ?? null;
	const orgNameById = useMemo(() => {
		const names = new Map<string, string>();
		for (const org of profile?.organizations ?? []) names.set(org.id, org.name);
		return names;
	}, [profile?.organizations]);
	const apiTokens = activeTokens(apiTokensQuery.data?.apiTokens ?? []);

	const onCopyCreatedApiToken = (): void => {
		if (!createdApiToken) return;
		setCopiedApiToken(true);
		window.setTimeout(() => setCopiedApiToken(false), 1800);
		void copyToClipboard(createdApiToken.token)
			.then(() => toast.success("API token copied"))
			.catch((error) =>
				toast.error(
					"Unable to copy API token",
					error instanceof Error ? error.message : undefined,
				),
			);
	};

	const onCopyCreatedCurl = (): void => {
		if (!createdApiToken) return;
		setCopiedCurl(true);
		window.setTimeout(() => setCopiedCurl(false), 1800);
		void copyToClipboard(buildAutomationUploadCurl(createdApiToken.token))
			.then(() => toast.success("Upload command copied"))
			.catch((error) =>
				toast.error(
					"Unable to copy upload command",
					error instanceof Error ? error.message : undefined,
				),
			);
	};

	const onCopyListedApiToken = (token: ApiAutomationApiToken): void => {
		if (!token.token) {
			toast.error("Token secret is not available");
			return;
		}
		void copyToClipboard(token.token)
			.then(() => toast.success("API token copied"))
			.catch((error) =>
				toast.error(
					"Unable to copy API token",
					error instanceof Error ? error.message : undefined,
				),
			);
	};

	const onCreateApiToken = (event: React.FormEvent<HTMLFormElement>): void => {
		event.preventDefault();
		const trimmedLabel = apiTokenLabel.trim() || DEFAULT_API_TOKEN_LABEL;
		const parsedDays = Number.parseInt(apiTokenExpiryDays, 10);
		const expiresInDays = Number.isFinite(parsedDays)
			? Math.min(3650, Math.max(1, parsedDays))
			: 365;

		createApiToken.mutate(
			{
				label: trimmedLabel,
				permanent: apiTokenPermanent,
				...(activeOrg ? { orgId: activeOrg.id } : {}),
				...(apiTokenPermanent ? {} : { expiresInDays }),
			},
			{
				onSuccess: (payload) => {
					setApiTokenLabel(DEFAULT_API_TOKEN_LABEL);
					setApiTokenExpiryDays(DEFAULT_API_TOKEN_EXPIRY_DAYS);
					setApiTokenPermanent(false);
					setCreatedApiToken({
						id: payload.apiToken.id,
						token: payload.token,
					});
					setCopiedApiToken(false);
					setCopiedCurl(false);
					toast.success("API token created");
				},
				onError: (error) => {
					toast.error(
						"Unable to create API token",
						error instanceof Error ? error.message : undefined,
					);
				},
			},
		);
	};

	const onConfirmRevokeApiToken = (): void => {
		if (!tokenToRevoke) return;
		revokeApiToken.mutate(tokenToRevoke.id, {
			onSuccess: () => {
				toast.success("API token revoked");
				if (createdApiToken?.id === tokenToRevoke.id) {
					setCreatedApiToken(null);
					setCopiedApiToken(false);
					setCopiedCurl(false);
				}
				setTokenToRevoke(null);
			},
			onError: (error) => {
				toast.error(
					"Unable to revoke API token",
					error instanceof Error ? error.message : undefined,
				);
			},
		});
	};

	return (
		<>
			<SettingCard
				title="API tokens"
				description="Use from CLI or external automation to upload evidence ZIP files."
			>
				<div className="flex flex-col gap-5">
					<TokenWarning>
						This token can create evidence in the active workspace. Uploaded ZIPs
						must be 20 MB or less and contain only the standard archive and video
						files.
					</TokenWarning>

					<form
						className="grid gap-3 md:grid-cols-[minmax(0,1fr)_8rem_auto]"
						onSubmit={onCreateApiToken}
					>
						<Field label="Label" htmlFor="api-token-label">
							<Input
								id="api-token-label"
								value={apiTokenLabel}
								onChange={(event) => setApiTokenLabel(event.target.value)}
								placeholder={DEFAULT_API_TOKEN_LABEL}
								disabled={createApiToken.isPending}
							/>
						</Field>
						<Field label="Days" htmlFor="api-token-expiry">
							<Input
								id="api-token-expiry"
								type="number"
								min={1}
								max={3650}
								value={apiTokenExpiryDays}
								onChange={(event) => setApiTokenExpiryDays(event.target.value)}
								disabled={createApiToken.isPending || apiTokenPermanent}
							/>
						</Field>
						<div className="flex items-end">
							<Button
								type="submit"
								size="md"
								className="w-full md:w-auto"
								disabled={
									createApiToken.isPending ||
									profileQuery.isPending ||
									activeOrg === null
								}
							>
								<Plus aria-hidden />
								{createApiToken.isPending ? "Creating..." : "Create token"}
							</Button>
						</div>
						<label className="flex items-center gap-2 text-base text-muted-foreground md:col-span-3">
							<input
								type="checkbox"
								className="size-4 accent-primary"
								checked={apiTokenPermanent}
								disabled={createApiToken.isPending}
								onChange={(event) =>
									setApiTokenPermanent(event.currentTarget.checked)
								}
							/>
							Permanent token
						</label>
					</form>

					{createdApiToken ? (
						<CreatedTokenPanel
							token={createdApiToken.token}
							copyLabel="Copy token"
							copied={copiedApiToken}
							onCopy={onCopyCreatedApiToken}
							extraAction={
								<button
									type="button"
									onClick={onCopyCreatedCurl}
									className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 font-medium text-primary-foreground transition-colors hover:bg-primary/90"
								>
									{copiedCurl ? (
										<Check className="size-3.5" aria-hidden />
									) : (
										<Copy className="size-3.5" aria-hidden />
									)}
									{copiedCurl ? "Copied curl" : "Copy curl"}
								</button>
							}
						>
							Use this as a Bearer token when uploading automation evidence.
						</CreatedTokenPanel>
					) : null}

					<div className="rounded-lg border border-border bg-black/20 p-3">
						<div className="mb-2 flex items-center gap-2 text-base font-semibold">
							<FileArchive className="size-4 text-primary" aria-hidden />
							ZIP format
						</div>
						<div className="grid gap-2 text-base text-muted-foreground sm:grid-cols-3">
							<span>Max size: 20 MB</span>
							<span>session.archive.json</span>
							<span>recording.webm</span>
						</div>
					</div>

					<div className="overflow-hidden rounded-lg border border-border">
						{apiTokensQuery.isPending ? (
							<div className="space-y-2 p-3">
								<Skeleton className="h-12 w-full" />
								<Skeleton className="h-12 w-full" />
							</div>
						) : apiTokens.length === 0 ? (
							<div className="flex items-center gap-3 p-4 text-base text-muted-foreground">
								<span className="grid size-10 place-items-center rounded-lg border border-border bg-secondary">
									<KeyRound className="size-4" aria-hidden />
								</span>
								No API tokens yet
							</div>
						) : (
							<div className="divide-y divide-border">
								{apiTokens.map((token) => (
									<div
										key={token.id}
										className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_auto]"
									>
										<div className="min-w-0">
											<div className="flex flex-wrap items-center gap-2">
												<p className="truncate text-base font-semibold text-foreground">
													{token.label}
												</p>
												<TokenStatusBadge token={token} />
												<Badge variant="outline">
													{orgNameById.get(token.orgId) ?? "Workspace"}
												</Badge>
											</div>
											<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-base text-muted-foreground">
												<TokenSecret
													token={token}
													onCopy={() => onCopyListedApiToken(token)}
												/>
												<span className="inline-flex items-center gap-1.5">
													<CalendarClock className="size-3.5" aria-hidden />
													Expires {formatExpiry(token.expiresAt)}
												</span>
												<span>Last used {formatDateTime(token.lastUsedAt)}</span>
											</div>
											<p className="mt-2 text-base text-muted-foreground">
												Scopes: {token.scopes.join(", ") || "none"}
											</p>
										</div>
										<div className="flex items-center justify-end gap-2">
											<Button
												variant="destructive"
												size="sm"
												disabled={token.revokedAt !== null || revokeApiToken.isPending}
												onClick={() => setTokenToRevoke(token)}
											>
												<Trash2 aria-hidden />
												Revoke
											</Button>
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				</div>
			</SettingCard>
			<ConfirmDialog
				open={Boolean(tokenToRevoke)}
				title="Revoke API token"
				description={
					tokenToRevoke
						? `${tokenToRevoke.label} will stop working immediately.`
						: undefined
				}
				confirmLabel="Revoke"
				destructive
				busy={revokeApiToken.isPending}
				onConfirm={onConfirmRevokeApiToken}
				onCancel={() => setTokenToRevoke(null)}
			/>
		</>
	);
}
