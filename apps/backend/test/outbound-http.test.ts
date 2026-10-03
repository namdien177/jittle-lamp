import { describe, expect, it } from "bun:test";

import {
	assertOutboundUrl,
	guardedFetch,
	isNonPublicAddress,
	OutboundBlockedError,
	type OutboundPolicy,
	outboundPolicyFromEnv,
} from "../src/services/outbound-http";

const resolvesTo =
	(...addresses: string[]): NonNullable<OutboundPolicy["lookup"]> =>
	async () =>
		addresses;

const policy = (overrides: Partial<OutboundPolicy> = {}): OutboundPolicy => ({
	allowLoopback: false,
	allowHosts: [],
	lookup: resolvesTo("93.184.216.34"),
	...overrides,
});

const blocked = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(OutboundBlockedError);
		return (error as Error).message;
	}
	throw new Error("expected the URL to be refused");
};

describe("outbound HTTP guard (SSRF)", () => {
	it("classifies private, local and metadata addresses", () => {
		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"224.0.0.1",
			"::1",
			"::",
			"fd12:3456::1",
			"fe80::1",
			"::ffff:10.0.0.1",
			"::ffff:127.0.0.1",
		]) {
			expect(isNonPublicAddress(address)).toBe(true);
		}
		for (const address of [
			"93.184.216.34",
			"8.8.8.8",
			"172.32.0.1",
			"2606:4700:4700::1111",
		]) {
			expect(isNonPublicAddress(address)).toBe(false);
		}
	});

	it("refuses hosts that resolve to non-public addresses, after DNS", async () => {
		expect(
			(await assertOutboundUrl(policy(), "https://hooks.example.com/x")).host,
		).toBe("hooks.example.com");
		expect(
			await blocked(
				assertOutboundUrl(
					policy({ lookup: resolvesTo("93.184.216.34", "10.0.0.5") }),
					"https://rebind.example.com/x",
				),
			),
		).toContain("private or local address");
		expect(
			await blocked(
				assertOutboundUrl(policy(), "http://169.254.169.254/latest/meta-data"),
			),
		).toContain("private or local");
		expect(
			await blocked(assertOutboundUrl(policy(), "http://[::1]:8080/")),
		).toContain("private or local");
		expect(
			await blocked(assertOutboundUrl(policy(), "file:///etc/passwd")),
		).toContain("http(s)");
		expect(
			await blocked(
				assertOutboundUrl(policy(), "https://user:pw@example.com/"),
			),
		).toContain("credentials");
	});

	it("allows loopback only with the flag, and named hosts from the allowlist", async () => {
		const local = "http://127.0.0.1:4010/hook";
		await blocked(assertOutboundUrl(policy(), local));
		expect(
			(await assertOutboundUrl(policy({ allowLoopback: true }), local)).port,
		).toBe("4010");
		// The flag never opens private ranges.
		await blocked(
			assertOutboundUrl(policy({ allowLoopback: true }), "http://10.0.0.8/"),
		);
		expect(
			(
				await assertOutboundUrl(
					policy({
						allowHosts: ["gitlab.internal.example"],
						lookup: resolvesTo("10.20.0.4"),
					}),
					"https://gitlab.internal.example/api/v4",
				)
			).hostname,
		).toBe("gitlab.internal.example");
		expect(
			outboundPolicyFromEnv({
				nodeEnv: "production",
				allowLoopbackFlag: undefined,
				allowHosts: " GitLab.Internal.Example , ",
			}),
		).toEqual({
			allowLoopback: false,
			allowHosts: ["gitlab.internal.example"],
		});
		expect(
			outboundPolicyFromEnv({
				nodeEnv: "test",
				allowLoopbackFlag: undefined,
				allowHosts: undefined,
			}).allowLoopback,
		).toBe(true);
	});

	it("reads JL_OUTBOUND_ALLOW_LOOPBACK like the other boolean flags", () => {
		const loopback = (flag: string | undefined) =>
			outboundPolicyFromEnv({
				nodeEnv: "development",
				allowLoopbackFlag: flag,
				allowHosts: undefined,
			}).allowLoopback;
		for (const flag of ["true", "TRUE", "1", "yes", " Yes ", "on"]) {
			expect(loopback(flag)).toBe(true);
		}
		for (const flag of [undefined, "", "false", "0", "no", "off", "maybe"]) {
			expect(loopback(flag)).toBe(false);
		}
	});

	it("never follows redirects, so credentials do not cross origins", async () => {
		const seen: Array<{ url: string; redirect: RequestRedirect | undefined }> =
			[];
		const fakeFetch = (async (
			url: string | URL | Request,
			init?: RequestInit,
		) => {
			seen.push({ url: String(url), redirect: init?.redirect });
			return new Response(null, {
				status: 302,
				headers: { location: "https://attacker.example.net/steal" },
			});
		}) as typeof fetch;
		const message = await blocked(
			guardedFetch(fakeFetch, policy(), "https://api.github.com/repos/a/b", {
				method: "POST",
				headers: { authorization: "Bearer github_pat_fake_0000" },
			}),
		);
		expect(message).toContain("redirects are not followed");
		expect(seen).toEqual([
			{ url: "https://api.github.com/repos/a/b", redirect: "manual" },
		]);
	});
});
