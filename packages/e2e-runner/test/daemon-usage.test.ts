import { describe, expect, test } from "bun:test";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { usage } from "../src/daemon";
import { defaultStatePath } from "../src/daemon/worker";

describe("jl-e2e-runner help", () => {
  test("names the state file the worker really uses", () => {
    const path = defaultStatePath("https://api.jittlelamp.example");
    expect(dirname(path)).toBe(join(homedir(), ".config", "jittle-lamp", "runner"));
    expect(basename(path)).toStartWith("api.jittlelamp.example-");
    expect(basename(path)).toContain(hostname().replace(/[^A-Za-z0-9.-]/g, "_"));
    expect(usage).toContain("~/.config/jittle-lamp/runner/<api host>-<host name>.json");
    expect(usage).not.toContain("<api host>.json");
  });
});
