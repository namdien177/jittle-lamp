import { createClerkClient } from "@clerk/backend";

import type { RuntimeConfig } from "../config/runtime";
import { normalizeMigrationEmail } from "./migration-security";

export type MigrationDirectoryProfile = {
	clerkUserId: string;
	verifiedPrimaryEmail: string | null;
	firstName: string | null;
	lastName: string | null;
	username: string | null;
	imageUrl: string | null;
	createdAt: number;
	warnings?: string[];
};

export type ClerkDirectory = {
	exportProfile(clerkUserId: string): Promise<MigrationDirectoryProfile>;
	findByVerifiedEmail(email: string): Promise<MigrationDirectoryProfile[]>;
	createUser(
		profile: MigrationDirectoryProfile,
	): Promise<MigrationDirectoryProfile>;
};

export const createClerkDirectory = (
	runtime: RuntimeConfig,
): ClerkDirectory => {
	if (!runtime.clerkSecretKey) {
		throw new Error("CLERK_SECRET_KEY is required for organization migration");
	}
	const client = createClerkClient({ secretKey: runtime.clerkSecretKey });
	const toProfile = (
		user: Awaited<ReturnType<typeof client.users.getUser>>,
	) => {
		const primary = user.emailAddresses.find(
			(address) => address.id === user.primaryEmailAddressId,
		);
		const verified =
			primary?.verification?.status === "verified"
				? primary.emailAddress
				: null;
		return {
			clerkUserId: user.id,
			verifiedPrimaryEmail: verified,
			firstName: user.firstName,
			lastName: user.lastName,
			username: user.username,
			imageUrl: user.imageUrl || null,
			createdAt: user.createdAt,
		} satisfies MigrationDirectoryProfile;
	};
	return {
		exportProfile: async (clerkUserId) =>
			toProfile(await client.users.getUser(clerkUserId)),
		findByVerifiedEmail: async (email) => {
			const result = await client.users.getUserList({
				emailAddress: [normalizeMigrationEmail(email)],
				limit: 100,
			});
			return result.data
				.map(toProfile)
				.filter(
					(profile) =>
						profile.verifiedPrimaryEmail &&
						normalizeMigrationEmail(profile.verifiedPrimaryEmail) ===
							normalizeMigrationEmail(email),
				);
		},
		createUser: async (profile) => {
			if (!profile.verifiedPrimaryEmail) {
				throw new Error(
					"A verified primary email is required to create a Clerk user",
				);
			}
			const fields = {
				emailAddress: [profile.verifiedPrimaryEmail],
				...(profile.firstName ? { firstName: profile.firstName } : {}),
				...(profile.lastName ? { lastName: profile.lastName } : {}),
				...(profile.username ? { username: profile.username } : {}),
				externalId: profile.clerkUserId,
				createdAt: new Date(profile.createdAt),
			};
			let created: Awaited<ReturnType<typeof client.users.createUser>>;
			try {
				created = await client.users.createUser({
					...fields,
					skipPasswordRequirement: true,
				});
			} catch (error) {
				const details =
					error instanceof Error ? error.message : JSON.stringify(error);
				if (!/password.{0,40}(required|requirement)/i.test(details))
					throw error;
				created = await client.users.createUser({
					...fields,
					password: Buffer.from(
						crypto.getRandomValues(new Uint8Array(32)),
					).toString("base64url"),
					skipPasswordChecks: true,
				});
			}
			const warnings: string[] = [];
			if (profile.imageUrl) {
				try {
					const response = await fetch(profile.imageUrl, { redirect: "error" });
					if (!response.ok) throw new Error("profile image download failed");
					created = await client.users.updateUserProfileImage(created.id, {
						file: await response.blob(),
					});
				} catch {
					warnings.push(
						"A migrated member's profile image could not be copied.",
					);
				}
			}
			return { ...toProfile(created), warnings };
		},
	};
};

export class InMemoryClerkDirectory implements ClerkDirectory {
	readonly profiles = new Map<string, MigrationDirectoryProfile>();

	constructor(profiles: readonly MigrationDirectoryProfile[] = []) {
		for (const profile of profiles)
			this.profiles.set(profile.clerkUserId, profile);
	}

	async exportProfile(clerkUserId: string): Promise<MigrationDirectoryProfile> {
		const profile = this.profiles.get(clerkUserId);
		if (!profile) throw new Error(`Clerk profile not found: ${clerkUserId}`);
		return profile;
	}

	async findByVerifiedEmail(
		email: string,
	): Promise<MigrationDirectoryProfile[]> {
		return [...this.profiles.values()].filter(
			(profile) =>
				profile.verifiedPrimaryEmail &&
				normalizeMigrationEmail(profile.verifiedPrimaryEmail) ===
					normalizeMigrationEmail(email),
		);
	}

	async createUser(
		profile: MigrationDirectoryProfile,
	): Promise<MigrationDirectoryProfile> {
		const created = {
			...profile,
			clerkUserId: `migrated_${crypto.randomUUID()}`,
		};
		this.profiles.set(created.clerkUserId, created);
		return created;
	}
}
