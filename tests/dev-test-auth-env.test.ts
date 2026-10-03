import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { writeDevAuthEnv } from "../scripts/dev/test-auth-env";

// `bun run dev:test-auth:setup` must never copy values from the root .env: when that file targets
// production, its APP_SECRET used to land in .env.dev-auth.

const root = join(import.meta.dir, "..");
const read = (path: string) => parseEnv(readFileSync(path, "utf8"));

describe("dev-auth env setup", () => {
  it("generates local secrets, keeps them across setups and uses only local defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-dev-auth-"));
    // A production-like .env next to the output must have no effect.
    writeFileSync(join(dir, ".env"), "APP_SECRET=prod-app-secret-do-not-copy-000000\nJITTLE_LAMP_WEB_ORIGIN=https://app.prod.example\n");
    const envPath = join(dir, ".env.dev-auth");

    await writeDevAuthEnv(envPath);
    const first = read(envPath);
    expect(first.APP_SECRET).toStartWith("dev-auth-");
    expect(first.APP_SECRET?.length).toBeGreaterThanOrEqual(24);
    expect(Buffer.from(first.JL_SECRETS_MASTER_KEY ?? "", "base64").byteLength).toBe(32);
    expect(first.JITTLE_LAMP_WEB_ORIGIN).toBe("http://127.0.0.1:4173");
    expect(first.DATABASE_URL).toBe("file:./local.dev-auth.db");
    expect(first.CLERK_SECRET_KEY).toBe("");
    const written = readFileSync(envPath, "utf8");
    expect(written).not.toContain("prod-app-secret");
    expect(written).not.toContain("app.prod.example");

    await writeDevAuthEnv(envPath);
    const second = read(envPath);
    expect(second.APP_SECRET).toBe(first.APP_SECRET);
    expect(second.JL_SECRETS_MASTER_KEY).toBe(first.JL_SECRETS_MASTER_KEY);
    // The dev token is fresh on every setup.
    expect(second.JITTLE_LAMP_DEV_AUTH_TOKEN).not.toBe(first.JITTLE_LAMP_DEV_AUTH_TOKEN);
  });

  it("never reads the root .env, and the package scripts stop Bun from loading it", () => {
    const source = readFileSync(join(root, "scripts/dev/test-auth-env.ts"), "utf8");
    expect(source).not.toMatch(/join\(rootDir,\s*"\.env"\)/);
    expect(source).not.toContain("rootEnv");
    const scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["dev:test-auth"]).toStartWith("bun --no-env-file ");
    expect(scripts["dev:test-auth:setup"]).toStartWith("bun --no-env-file ");
  });
});
