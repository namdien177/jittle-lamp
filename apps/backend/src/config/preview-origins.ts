import type { RuntimeConfig } from "./runtime";

/** Only staging with a Clerk test instance accepts this project's Vercel URLs. */
export const isVercelPreviewOrigin = (
	runtime: RuntimeConfig,
	origin: string,
): boolean => {
	if (
		runtime.nodeEnv !== "staging" ||
		!runtime.clerkPublishableKey?.startsWith("pk_test_") ||
		(runtime.clerkSecretKey !== undefined &&
			!runtime.clerkSecretKey.startsWith("sk_test_")) ||
		!runtime.vercelPreviewProject ||
		!runtime.vercelPreviewTeam
	)
		return false;
	try {
		const url = new URL(origin);
		if (
			url.protocol !== "https:" ||
			url.port ||
			url.username ||
			url.password ||
			url.pathname !== "/" ||
			url.search ||
			url.hash
		)
			return false;
		const prefix = `${runtime.vercelPreviewProject}-`;
		const suffix = `-${runtime.vercelPreviewTeam}.vercel.app`;
		if (!url.hostname.startsWith(prefix) || !url.hostname.endsWith(suffix))
			return false;
		const deployment = url.hostname.slice(prefix.length, -suffix.length);
		// Immutable deployment hashes have no separators; accepting branch names
		// here would also accept a different project prefix or team suffix.
		return /^[a-z0-9]{9}$/.test(deployment);
	} catch {
		return false;
	}
};

export const clerkAuthorizedPartiesForRequest = (
	runtime: RuntimeConfig,
	request: Request,
): string[] | undefined => {
	const origin = request.headers.get("origin");
	if (!origin || !isVercelPreviewOrigin(runtime, origin))
		return runtime.clerkAuthorizedParties;
	// Clerk still verifies the signature and requires the token's azp to match an
	// allowed origin. A request header alone cannot authorize another project's token.
	return [...(runtime.clerkAuthorizedParties ?? []), new URL(origin).origin];
};
