import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDecision, updateOnce } from "../deploy/runner/update-runner.mjs";

const plan = overrides => ({ poolId: "cloud-1", workerId: "worker-1", targetVersion: "2.0.0", version: "1.0.0", ready: true, ...overrides });

describe("host runner supervisor", () => {
  it("waits for all old workers to drain, rejects mixed pools/unsafe tags and skips matching versions", () => {
    expect(updateDecision([])).toBeNull();
    expect(updateDecision([plan({ ready: false })])).toBeNull();
    expect(updateDecision([plan({}), plan({ ready: false })])).toBeNull();
    expect(updateDecision([plan({}), plan({ version: "2.0.0", ready: false })])).toBe("2.0.0");
    expect(updateDecision([plan({ version: "2.0.0" })])).toBeNull();
    expect(() => updateDecision([plan({}), plan({ poolId: "another-org" })])).toThrow("per pool");
    expect(() => updateDecision([plan({ targetVersion: "latest;rm" })])).toThrow("invalid");
  });

  function setup(options = {}) {
    const dir = mkdtempSync(join(tmpdir(), "jl-updater-"));
    const imageEnv = join(dir, "image.env");
    writeFileSync(imageEnv, "JL_RUNNER_IMAGE=registry.test/runner\nJL_RUNNER_IMAGE_TAG=1.0.0\nCUSTOM_SETTING=keep\n");
    const calls = [];
    let polls = 0;
    const docker = (args, env) => {
      calls.push({ args, env });
      if (args.includes("ps")) return "container1\ncontainer2";
      if (args[0] === "exec") return JSON.stringify({ apiOrigin: "https://api.test/prefix", workerToken: "jl_worker_never_log" });
      if (args[0] === "run") return options.wrongImageVersion ? "0.0.0" : "2.0.0";
      if (args.includes("up") && options.failCompose) throw new Error("compose failed");
      return "";
    };
    const fetch = async (url, init) => {
      expect(url).toBe("https://api.test/prefix/runner-pools/update-plan");
      expect(init.headers.authorization).toBe("Bearer jl_worker_never_log");
      polls++;
      return Response.json(plan({ targetVersion: options.cancel && polls > 2 ? null : "2.0.0" }));
    };
    return { dir, imageEnv, calls, options: { compose: join(dir, "compose.yaml"), imageEnv, image: "registry.test/runner", docker, fetch } };
  }

  it("pulls and verifies a release, re-checks drain, preserves scale and persists the new pin", async () => {
    const f = setup();
    expect(await updateOnce(f.options)).toBe("2.0.0");
    expect(f.calls.some(call => call.args[0] === "pull")).toBe(true);
    const up = f.calls.find(call => call.args.includes("up"));
    expect(up.args).toContain("runner=2");
    expect(up.args).not.toContain("--force-recreate");
    expect(up.env.JL_RUNNER_IMAGE_TAG).toBe("2.0.0");
    expect(readFileSync(f.imageEnv, "utf8")).toContain("JL_RUNNER_IMAGE_TAG=2.0.0");
    expect(readFileSync(f.imageEnv, "utf8")).toContain("CUSTOM_SETTING=keep");
  });

  it("uses preloaded images offline and never changes the pin on cancellation, wrong version or compose failure", async () => {
    const offline = setup();
    await updateOnce({ ...offline.options, offline: true });
    expect(offline.calls.some(call => call.args[0] === "pull")).toBe(false);
    for (const options of [{ cancel: true }, { wrongImageVersion: true }, { failCompose: true }]) {
      const f = setup(options);
      await updateOnce(f.options).catch(() => undefined);
      expect(readFileSync(f.imageEnv, "utf8")).toContain("JL_RUNNER_IMAGE_TAG=1.0.0");
      if (!options.failCompose) expect(f.calls.some(call => call.args.includes("up"))).toBe(false);
    }
  });
});

import { createPullProgress } from "../deploy/runner/docker-pull.mjs";

describe("Docker download byte progress", () => {
  it("waits for all layer sizes, counts completed downloads and excludes cached layers", () => {
    const consume = createPullProgress();
    consume({ id: "a", status: "Pulling fs layer" });
    consume({ id: "b", status: "Pulling fs layer" });
    consume({ id: "cached", status: "Already exists" });
    expect(consume({ id: "a", status: "Downloading", progressDetail: { current: 50, total: 100 } }).downloadPercent).toBeNull();
    expect(consume({ id: "b", status: "Downloading", progressDetail: { current: 0, total: 300 } })).toEqual({ downloadPercent: 12, downloadedBytes: 50, totalBytes: 400 });
    expect(consume({ id: "a", status: "Download complete" }).downloadPercent).toBe(25);
    expect(consume({ id: "b", status: "Downloading", progressDetail: { current: 200, total: 300 } }).downloadPercent).toBe(75);
    expect(consume({ id: "b", status: "Extracting", progressDetail: { current: 1, total: 1000 } })).toEqual({ downloadPercent: 100, downloadedBytes: 400, totalBytes: 400 });
    expect(consume({ id: "new", status: "Pulling fs layer" }).downloadPercent).toBeNull();
  });
});

describe("host update progress reports", () => {
  function fixture({ failPull = false, cancel = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "jl-progress-"));
    const imageEnv = join(dir, "image.env");
    writeFileSync(imageEnv, "JL_RUNNER_IMAGE=registry.test/runner\nJL_RUNNER_IMAGE_TAG=1.0.0\n");
    const reports = [];
    let restarted = false;
    let polls = 0;
    const docker = args => {
      if (args.includes("ps")) return restarted ? "replacement" : "old";
      if (args[0] === "exec") return JSON.stringify({ apiOrigin: "https://api.test", workerToken: restarted ? "jl_worker_new" : "jl_worker_old" });
      if (args[0] === "run") return "2.0.0";
      if (args.includes("up")) restarted = true;
      return "";
    };
    const fetch = async (url, init) => {
      if (url.endsWith("update-progress")) { reports.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
      polls++;
      const replaced = init.headers.authorization.includes("new");
      return Response.json(plan({ progressReporting: true, updateId: 1234, workerId: replaced ? "worker-new" : "worker-old", version: replaced ? "2.0.0" : "1.0.0", targetVersion: cancel && polls > 1 ? null : "2.0.0" }));
    };
    const pull = async (_image, onProgress) => {
      if (failPull) throw new Error("private registry URL should never reach the API");
      onProgress({ downloadPercent: 42, downloadedBytes: 420, totalBytes: 1000 });
    };
    return { reports, options: { compose: join(dir, "compose.yaml"), imageEnv, image: "registry.test/runner", docker, fetch, pull } };
  }
  it("reports actual phases and only completes after replacement workers reconnect", async () => {
    const f = fixture();
    await updateOnce(f.options);
    expect(f.reports.map(item => item.phase)).toEqual(["draining", "downloading", "verifying", "restarting", "reconnecting", "completed"]);
    expect(f.reports.at(-1).replacementWorkerIds).toEqual(["worker-new"]);
    expect(f.reports.every(item => item.updateId === 1234)).toBe(true);
  });
  it("reports a bounded error code and never restarts a cancelled update", async () => {
    const failed = fixture({ failPull: true });
    await expect(updateOnce(failed.options)).rejects.toThrow();
    expect(failed.reports.at(-1)).toMatchObject({ phase: "failed", errorCode: "DOWNLOAD_FAILED" });
    expect(JSON.stringify(failed.reports)).not.toContain("private registry");
    const cancelled = fixture({ cancel: true });
    expect(await updateOnce(cancelled.options)).toBeNull();
    expect(cancelled.reports.some(item => item.phase === "restarting")).toBe(false);
  });
});
