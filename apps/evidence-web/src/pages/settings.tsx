import {
	Building2,
	CalendarClock,
	Check,
	Copy,
	ExternalLink,
	KeyRound,
	Plus,
	ShieldCheck,
	Terminal,
	Trash2,
	UserCog,
} from "lucide-react";
import type React from "react";
import { useState } from "react";
import { Link } from "react-router";

import type { ApiAiAccessToken } from "../api";
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
	useCreateAiAccessToken,
	useRevokeAiAccessToken,
} from "../queries";
import { useToast } from "../toast";
import { copyToClipboard } from "../utils";

const INSTALL_COMMAND =
	"curl -fsSL https://raw.githubusercontent.com/namdien177/jittle-lamp/main/scripts/release/install-macos-desktop.sh | bash";

const DEFAULT_AI_TOKEN_LABEL = "AI evidence debugger";
const DEFAULT_AI_TOKEN_EXPIRY_DAYS = "90";

function buildAiEvidencePrompt(token: string): string {
	return `Use Jittle Lamp's AI evidence debugging instructions from ${apiOrigin}/llms.txt.

AI access token:
${token}

When I give you an evidence link or evidence id, use that token as:
Authorization: Bearer ${token}

Fetch the evidence debug information, inspect the session archive, console, network, lifecycle events, and artifacts, then explain what is confirmed by the evidence and what is only a hypothesis.`;
}

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

export function SettingsPage(): React.JSX.Element {
	const clerk = useClerk();
	const toast = useToast();
	const profileQuery = useAccountProfile();
	const aiTokensQuery = useAiAccessTokens();
	const createAiToken = useCreateAiAccessToken();
	const revokeAiToken = useRevokeAiAccessToken();
	const profile = profileQuery.data ?? null;
	const activeOrg = profile?.organizations.find((org) => org.isActive) ?? null;
	const [copied, setCopied] = useState(false);
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

	const aiTokens = aiTokensQuery.data?.accessTokens ?? [];

	return (
		<>
			<PageHeader eyebrow="Workspace" title="Settings" />
			<PageBody className="max-w-3xl">
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
									{profile?.user.email ?? "—"}
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
									: "—"}
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
					title="AI access tokens"
					description="External evidence debugging."
				>
					<div className="flex flex-col gap-5">
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
							<div className="rounded-lg border border-primary/30 bg-primary/10 p-3">
								<div className="mb-2 flex items-center gap-2 text-base font-semibold text-foreground">
									<ShieldCheck className="size-4 text-primary" aria-hidden />
									Copy this token now
								</div>
								<div className="flex items-center gap-2 overflow-hidden rounded-md border border-border bg-black/30 pl-3 pr-1.5 font-mono text-base">
									<code className="flex-1 truncate py-2.5 text-muted-foreground">
										{createdAiToken.token}
									</code>
									<div className="my-1 flex shrink-0 items-center gap-1">
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
										<button
											type="button"
											onClick={onCopyAiToken}
											className="inline-flex items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 font-medium text-foreground transition-colors hover:bg-white/[0.08]"
										>
											{copiedAiToken ? (
												<Check className="size-3.5 text-primary" aria-hidden />
											) : (
												<Copy className="size-3.5" aria-hidden />
											)}
											{copiedAiToken ? "Copied token" : "Copy token"}
										</button>
									</div>
								</div>
							</div>
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
									{aiTokens.map((token) => {
										const revoked = token.revokedAt !== null;
										const expired =
											token.expiresAt !== null && token.expiresAt <= Date.now();
										return (
											<div
												key={token.id}
												className="grid gap-3 p-4 md:grid-cols-[minmax(0,1fr)_auto]"
											>
												<div className="min-w-0">
													<div className="flex flex-wrap items-center gap-2">
														<p className="truncate text-base font-semibold text-foreground">
															{token.label}
														</p>
														<Badge
															variant={
																revoked || expired
																	? "muted"
																	: token.lastUsedAt
																		? "success"
																		: "outline"
															}
														>
															{revoked
																? "Revoked"
																: expired
																	? "Expired"
																	: token.lastUsedAt
																		? "Used"
																		: "New"}
														</Badge>
													</div>
													<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-base text-muted-foreground">
														<span className="inline-flex items-center gap-1.5 font-mono">
															<KeyRound className="size-3.5" aria-hidden />
															{formatTokenPrefix(token.tokenPrefix)}
														</span>
														<span className="inline-flex items-center gap-1.5">
															<CalendarClock className="size-3.5" aria-hidden />
															Expires {formatExpiry(token.expiresAt)}
														</span>
														<span>
															Last used {formatDateTime(token.lastUsedAt)}
														</span>
													</div>
												</div>
												<div className="flex items-center justify-end">
													<Button
														variant="destructive"
														size="sm"
														disabled={revoked || revokeAiToken.isPending}
														onClick={() => setTokenToRevoke(token)}
													>
														<Trash2 aria-hidden />
														Revoke
													</Button>
												</div>
											</div>
										);
									})}
								</div>
							)}
						</div>
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
						className={cn(
							buttonVariants({ variant: "ghost", size: "sm" }),
							"mt-3",
						)}
					>
						Get the browser extension
						<ExternalLink aria-hidden />
					</a>
				</SettingCard>
			</PageBody>
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
