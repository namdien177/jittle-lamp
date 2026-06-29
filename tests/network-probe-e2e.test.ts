import { describe, expect, test } from "bun:test";

describe("network probe e2e", () => {
  test("does not block POST bodies before they reach the server", async () => {
    const child = Bun.spawn({
      cmd: ["bun", "run", "tests/fixtures/network-probe-e2e-runner.ts"],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe"
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ]);

    expect(stdout).toContain("network probe e2e passed");
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });
});
