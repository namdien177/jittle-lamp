import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const installer = fileURLToPath(
	new URL("../scripts/install-mcp.sh", import.meta.url),
);
const token = "jl_ai_install_test_secret_012345678901234567890";
type Invocation = {
	command: string;
	args: string[];
	cwd: string;
	inheritedToken: string | null;
};

const stubSource = String.raw`
import { appendFileSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const command = process.argv[2];
const args = process.argv.slice(3);
const root = process.env.TEST_MCP_STATE_DIR;
appendFileSync(join(root, 'invocations.jsonl'), JSON.stringify({ command, args, cwd: process.cwd(), inheritedToken: process.env.JL_AI_TOKEN ?? null }) + '\n');
if (command === 'bun') {
  if (args[0] === '--version') { console.log('1.3.14'); process.exit(0); }
  if (args[0] === 'build') writeFileSync(args[args.indexOf('--outfile') + 1], 'new MCP bundle');
  if (args[0] === process.env.TEST_MCP_FAIL_BUN) { console.error('simulated build failure'); process.exit(23); }
  process.exit(0);
}
if (command === 'git') {
  if (args[0] !== 'clone') process.exit(40);
  cpSync(process.env.TEST_MCP_SOURCE_DIR, args.at(-1), { recursive: true });
  process.exit(0);
}
const statePath = join(root, command + '.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
if (args[1] === 'add') {
  if (command === 'claude' && process.env.TEST_MCP_CLAUDE_ERROR) { console.error('permission denied: ' + process.env.TEST_MCP_SECRET); process.exit(21); }
  if (command === 'claude' && state.jittlelamp) { console.error('MCP server jittlelamp already exists in user config'); process.exit(1); }
  state.jittlelamp = { args };
} else if (args[1] === 'remove') {
  if (command !== 'claude' || JSON.stringify(args) !== JSON.stringify(['mcp', 'remove', '--scope', 'user', 'jittlelamp'])) process.exit(41);
  delete state.jittlelamp;
} else { process.exit(42); }
writeFileSync(statePath, JSON.stringify(state));
console.log('client echoed secret: ' + process.env.TEST_MCP_SECRET);
console.error('client stderr secret: ' + process.env.TEST_MCP_SECRET);
`;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(clients = ["codex", "claude"]) {
	const directory = realpathSync(
		mkdtempSync(join(tmpdir(), "jl-mcp-install-")),
	);
	const bin = join(directory, "fake commands");
	const source = join(directory, "source checkout");
	const install = join(directory, "installed MCP");
	const state = join(directory, "fake client state");
	for (const path of [bin, join(source, "apps/mcp/src"), install, state]) {
		mkdirSync(path, { recursive: true });
	}
	writeFileSync(join(source, "apps/mcp/src/index.ts"), "export {};");
	writeFileSync(join(source, "bun.lock"), "fixture lock");
	const stubPath = join(directory, "command-stub.mjs");
	writeFileSync(stubPath, stubSource);
	for (const command of ["bun", "git", ...clients]) {
		const path = join(bin, command);
		writeFileSync(
			path,
			`#!/bin/bash\nexec ${shellQuote(process.execPath)} run ${shellQuote(stubPath)} ${shellQuote(command)} "$@"\n`,
		);
		chmodSync(path, 0o700);
	}
	for (const client of clients) {
		writeFileSync(
			join(state, `${client}.json`),
			JSON.stringify({ unrelated: { command: "keep-me" } }),
		);
	}
	const env: Record<string, string | undefined> = {
		...process.env,
		// Exclude installed user CLIs. Every reachable client writes only to the fixture.
		PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
		JL_AI_TOKEN: token,
		JITTLE_LAMP_API_ORIGIN: "https://api.example.test/proxy",
		JITTLE_LAMP_WEB_ORIGIN: "https://viewer.example.test",
		TEST_MCP_STATE_DIR: state,
		TEST_MCP_SOURCE_DIR: source,
		TEST_MCP_SECRET: token,
	};
	const run = (
		options: {
			client?: string;
			piped?: boolean;
			remote?: boolean;
			detached?: boolean;
			env?: Record<string, string | undefined>;
		} = {},
	) => {
		const args = [
			"--client",
			options.client ?? "both",
			"--install-dir",
			install,
			...(options.remote
				? ["--repo", "https://example.test/source.git", "--ref", "v-test"]
				: ["--source-dir", source]),
		];
		const command = options.piped
			? ["/bin/bash", "-s", "--", ...args]
			: ["/bin/bash", installer, ...args];
		const result = Bun.spawnSync(command, {
			env: { ...env, ...options.env },
			detached: options.detached ?? false,
			stdin: options.piped ? readFileSync(installer) : Buffer.alloc(0),
			timeout: 10_000,
		});
		return {
			code: result.exitCode,
			output: result.stdout.toString() + result.stderr.toString(),
		};
	};
	const invocations = (): Invocation[] => {
		const path = join(state, "invocations.jsonl");
		return existsSync(path)
			? readFileSync(path, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line))
			: [];
	};
	const registrations = () =>
		invocations().filter((call) => ["codex", "claude"].includes(call.command));
	const config = (client: string) =>
		JSON.parse(readFileSync(join(state, `${client}.json`), "utf8"));
	return {
		directory,
		bin,
		source,
		install,
		run,
		invocations,
		registrations,
		config,
	};
}

describe("MCP installer", () => {
	test("registers both clients with separate arguments for space-containing paths and hides tokens", () => {
		const f = fixture();
		try {
			const result = f.run();
			expect(result.code).toBe(0);
			expect(result.output).not.toContain(token);
			expect(readFileSync(join(f.install, "index.js"), "utf8")).toBe(
				"new MCP bundle",
			);
			const registrations = f.registrations();
			expect(registrations.map((call) => call.command)).toEqual([
				"codex",
				"claude",
			]);
			for (const call of registrations) {
				expect(call.args).toContain(`JL_AI_TOKEN=${token}`);
				expect(call.args).toContain(
					"JITTLE_LAMP_API_ORIGIN=https://api.example.test/proxy",
				);
				expect(call.args).toContain(
					"JITTLE_LAMP_WEB_ORIGIN=https://viewer.example.test",
				);
				expect(call.args.slice(call.args.indexOf("--") + 1)).toEqual([
					join(f.bin, "bun"),
					"run",
					join(f.install, "index.js"),
				]);
			}
			expect(registrations[1]?.args.slice(0, 7)).toEqual([
				"mcp",
				"add",
				"--scope",
				"user",
				"--transport",
				"stdio",
				"jittlelamp",
			]);
			const install = f
				.invocations()
				.find((call) => call.command === "bun" && call.args[0] === "install");
			expect(install?.args).toEqual([
				"install",
				"--frozen-lockfile",
				"--ignore-scripts",
			]);
			expect(install?.cwd).toBe(f.source);
			expect(install?.inheritedToken).toBeNull();
			expect(
				f
					.invocations()
					.find((call) => call.command === "bun" && call.args[0] === "build")
					?.inheritedToken,
			).toBeNull();
		} finally {
			rmSync(f.directory, { recursive: true, force: true });
		}
	});

	test("replaces only the existing Claude user entry on a repeated installation", () => {
		const f = fixture();
		try {
			expect(f.run({ client: "claude" }).code).toBe(0);
			const second = f.run({ client: "claude" });
			expect(second.code).toBe(0);
			expect(second.output).not.toContain(token);
			expect(f.registrations().map((call) => call.args[1])).toEqual([
				"add",
				"add",
				"remove",
				"add",
			]);
			expect(f.config("claude").unrelated).toEqual({ command: "keep-me" });
			expect(f.config("claude").jittlelamp).toBeDefined();
		} finally {
			rmSync(f.directory, { recursive: true, force: true });
		}
	});

	for (const stage of ["install", "build", "run"]) {
		test(`preserves the old bundle and registrations when ${stage} fails`, () => {
			const f = fixture();
			try {
				writeFileSync(join(f.install, "index.js"), "previous bundle");
				const result = f.run({ env: { TEST_MCP_FAIL_BUN: stage } });
				expect(result.code).not.toBe(0);
				expect(result.output).not.toContain(token);
				expect(readFileSync(join(f.install, "index.js"), "utf8")).toBe(
					"previous bundle",
				);
				expect(f.registrations()).toEqual([]);
			} finally {
				rmSync(f.directory, { recursive: true, force: true });
			}
		});
	}

	test("does not remove an existing Claude entry for unrelated client errors", () => {
		const f = fixture();
		try {
			expect(f.run({ client: "claude" }).code).toBe(0);
			const before = f.config("claude");
			const result = f.run({
				client: "claude",
				env: { TEST_MCP_CLAUDE_ERROR: "permission-denied" },
			});
			expect(result.code).not.toBe(0);
			expect(result.output).not.toContain(token);
			expect(f.registrations().map((call) => call.args[1])).toEqual([
				"add",
				"add",
			]);
			expect(f.config("claude")).toEqual(before);
		} finally {
			rmSync(f.directory, { recursive: true, force: true });
		}
	});

	test("rejects missing clients and malformed tokens before registration", () => {
		const missing = fixture(["codex"]);
		const invalid = fixture();
		try {
			const missingResult = missing.run();
			expect(missingResult.code).not.toBe(0);
			expect(missingResult.output).toContain("Install Claude Code first");
			expect(missing.registrations()).toEqual([]);
			const invalidResult = invalid.run({
				env: { JL_AI_TOKEN: "invalid-private-value" },
			});
			expect(invalidResult.code).not.toBe(0);
			expect(invalidResult.output).toContain("Invalid token format");
			expect(invalidResult.output).not.toContain("invalid-private-value");
			expect(invalid.registrations()).toEqual([]);
		} finally {
			rmSync(missing.directory, { recursive: true, force: true });
			rmSync(invalid.directory, { recursive: true, force: true });
		}
	});

	test("registers an existing automation token without exposing it", () => {
		const f = fixture();
		const automationToken = "jl_api_install_test_secret_012345678901234567890";
		try {
			const result = f.run({
				env: { JL_AI_TOKEN: automationToken, TEST_MCP_SECRET: automationToken },
			});
			expect(result.code).toBe(0);
			expect(result.output).not.toContain(automationToken);
			expect(f.registrations()).toHaveLength(2);
			for (const call of f.registrations()) {
				expect(call.args).toContain(`JL_AI_TOKEN=${automationToken}`);
				expect(call.inheritedToken).toBeNull();
			}
		} finally {
			rmSync(f.directory, { recursive: true, force: true });
		}
	});

	test("fails clearly when a piped installation has no token and no controlling terminal", () => {
		const f = fixture();
		try {
			const result = f.run({
				piped: true,
				detached: true,
				env: { JL_AI_TOKEN: undefined },
			});
			expect(result.code).not.toBe(0);
			expect(result.output).toContain("No terminal available");
			expect(f.registrations()).toEqual([]);
		} finally {
			rmSync(f.directory, { recursive: true, force: true });
		}
	});

	test("supports piped unattended installation from a supplied checkout or cloned ref", () => {
		for (const remote of [false, true]) {
			const f = fixture();
			try {
				const result = f.run({ client: "codex", piped: true, remote });
				expect(result.code).toBe(0);
				expect(result.output).not.toContain(token);
				expect(f.registrations()).toHaveLength(1);
				const clone = f.invocations().find((call) => call.command === "git");
				if (remote) {
					expect(clone?.args.slice(0, 7)).toEqual([
						"clone",
						"--depth",
						"1",
						"--branch",
						"v-test",
						"--",
						"https://example.test/source.git",
					]);
					expect(clone?.inheritedToken).toBeNull();
				} else expect(clone).toBeUndefined();
			} finally {
				rmSync(f.directory, { recursive: true, force: true });
			}
		}
	});
});
