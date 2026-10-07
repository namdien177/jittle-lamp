#!/usr/bin/env node
// Host-side supervisor. The runner itself never receives the Docker socket.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pullImage, runDocker } from "./docker-pull.mjs";

const releaseVersion = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const stateScript = `const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const api=new URL(process.env.JL_API_ORIGIN).host.replace(/[^A-Za-z0-9.-]/g,'_');const host=os.hostname().replace(/[^A-Za-z0-9.-]/g,'_');process.stdout.write(fs.readFileSync(path.join(os.homedir(),'.config/jittle-lamp/runner',api+'-'+host+'.json'),'utf8'));`;

export function updateDecision(plans) {
  if (plans.length === 0) return null;
  const target = plans[0].targetVersion;
  if (!target) return null;
  if (!releaseVersion.test(target)) throw new Error("Server requested an invalid release version");
  if (!plans.every(plan => plan.poolId === plans[0].poolId && plan.targetVersion === target)) {
    throw new Error("Use one runner deployment per pool; update plans differ");
  }
  if (plans.every(plan => plan.version === target)) return null;
  // The server only marks ready after a heartbeat acknowledges draining with load=0.
  if (!plans.every(plan => plan.version === target || plan.ready === true)) return null;
  return target;
}

export async function updateOnce(options) {
  const imageEnv = resolve(options.imageEnv);
  const docker = options.docker ?? ((args, extraEnv = {}) => execFileSync("docker", args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv }, maxBuffer: 2 * 1024 * 1024
  }).trim());
  const compose = ["compose", "--env-file", imageEnv, "-f", resolve(options.compose)];
  const containers = docker([...compose, "ps", "-q", "runner"]).split(/\s+/).filter(Boolean);
  const states = containers.map(id => JSON.parse(docker(["exec", id, "node", "-e", stateScript])));
  for (const state of states) {
    const origin = new URL(state.apiOrigin);
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) {
      throw new Error("Runner update API requires HTTPS except on loopback");
    }
  }
  const api = async (state, path, body) => {
    const response = await (options.fetch ?? fetch)(`${state.apiOrigin.replace(/\/+$/, "")}/runner-pools/${path}`, {
      headers: { authorization: `Bearer ${state.workerToken}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000), redirect: "error"
    });
    if (!response.ok) {
      const error = new Error(`Runner update API returned ${response.status}`);
      error.updateChanged = response.status === 409;
      throw error;
    }
    return response.json();
  };
  const getPlans = async () => Promise.all(states.map(state => api(state, "update-plan")));
  const initial = await getPlans();
  const target = initial[0]?.targetVersion;
  if (!target) return null;
  if (initial.every(plan => plan.version === target)) {
    if (initial[0].progressReporting === true && initial[0].updatePhase !== "completed") await api(states[0], "update-progress", {
      updateId: initial[0].updateId, targetVersion: target, phase: "completed",
      replacementWorkerIds: initial.map(plan => plan.workerId)
    });
    return null;
  }
  if (!releaseVersion.test(target)) throw new Error("Server requested an invalid release version");
  if (!initial.every(plan => plan.poolId === initial[0].poolId && plan.targetVersion === target && plan.updateId === initial[0].updateId)) {
    throw new Error("Use one runner deployment per pool; update plans differ");
  }
  const reporting = initial[0].progressReporting === true;
  let phase = "draining";
  let details = { downloadPercent: null, downloadedBytes: null, totalBytes: null, errorCode: null };
  let reportError = null;
  let pending = Promise.resolve();
  let lastReport = 0;
  const report = () => {
    if (!reporting) return Promise.resolve(); // Existing servers can still use the updater.
    const body = { updateId: initial[0].updateId, targetVersion: target, phase, ...details };
    pending = pending.catch(() => undefined).then(() => api(states[0], "update-progress", body));
    pending.catch(error => { reportError = error; });
    lastReport = Date.now();
    return pending;
  };
  const setPhase = async (value, extra = {}) => {
    phase = value;
    details = { downloadPercent: null, downloadedBytes: null, totalBytes: null, errorCode: null, ...extra };
    await report();
  };
  const timer = reporting ? setInterval(() => { if (Date.now() - lastReport > 10_000) void report().catch(() => undefined); }, 1_000) : null;
  const asyncDocker = options.dockerAsync ?? (options.docker ? async (args, env) => docker(args, env) : runDocker);
  try {
    await setPhase("draining");
    if (!updateDecision(initial)) return null;
    const image = `${options.image}:${target}`;
    if (!options.offline) {
      await setPhase("downloading");
      await (options.pull ?? (options.docker ? async (name) => docker(["pull", name]) : pullImage))(image, progress => {
        details = { ...details, ...progress };
        if (Date.now() - lastReport >= 1_000) void report().catch(() => undefined);
      });
    }
    await setPhase("verifying");
    const actualVersion = await asyncDocker(["run", "--rm", "--entrypoint", "node", image, "/app/packages/e2e-runner/dist/daemon.js", "version"]);
    if (actualVersion !== target) throw new Error("Image version differs from requested release");
    if (reportError) throw reportError;
    // Pulls can take minutes. Re-check cancellation, worker drain and container membership.
    const plans = await getPlans();
    if (updateDecision(plans) !== target || plans.some(plan => plan.updateId !== initial[0].updateId)) return null;
    const currentContainers = docker([...compose, "ps", "-q", "runner"]).split(/\s+/).filter(Boolean);
    if (currentContainers.sort().join(" ") !== [...containers].sort().join(" ")) return null;
    await setPhase("restarting");
    await asyncDocker([...compose, "up", "-d", "--no-build", "--pull", "never", "--scale", `runner=${containers.length}`, "runner"], {
      JL_RUNNER_IMAGE: options.image, JL_RUNNER_IMAGE_TAG: target
    });
  const previous = readFileSync(imageEnv, "utf8");
  // Persist only after compose succeeds; retain unrelated deployment variables.
  const rest = previous.split(/\r?\n/).filter(line => !/^JL_RUNNER_IMAGE(?:_TAG)?=/.test(line)).join("\n").trim();
  writeFileSync(`${imageEnv}.tmp`, `${rest ? `${rest}\n` : ""}JL_RUNNER_IMAGE=${options.image}\nJL_RUNNER_IMAGE_TAG=${target}\n`, { mode: 0o600 });
  renameSync(`${imageEnv}.tmp`, imageEnv);
    if (reporting) {
      await setPhase("reconnecting");
      const deadline = Date.now() + (options.reconnectTimeoutMs ?? 120_000);
      let connected = false;
      do {
        try {
          const replacements = docker([...compose, "ps", "-q", "runner"]).split(/\s+/).filter(Boolean);
          const plans = await Promise.all(replacements.map(id => {
            const state = JSON.parse(docker(["exec", id, "node", "-e", stateScript]));
            return api(state, "update-plan");
          }));
          if (plans.length === containers.length && plans.every(plan => plan.version === target && plan.updateId === initial[0].updateId)) {
            await setPhase("completed", { replacementWorkerIds: plans.map(plan => plan.workerId) });
            connected = true;
            break;
          }
        } catch (error) { if (error.updateChanged) throw error; }
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 2_000));
      } while (Date.now() < deadline);
      if (!connected) throw new Error("Replacement runners have not reconnected");
    }
    return target;
  } catch (error) {
    if (!error.updateChanged) {
      const errorCode = ({ downloading: "DOWNLOAD_FAILED", verifying: "VERIFY_FAILED", restarting: "RESTART_FAILED", reconnecting: "RECONNECT_FAILED" })[phase];
      if (errorCode) await setPhase("failed", { errorCode }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    await pending.catch(() => undefined);
  }
}

export async function main(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument ${key}`);
    if (["--once", "--offline", "--help"].includes(key)) args.set(key, true);
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${key} needs a value`);
      args.set(key, value);
    }
  }
  if (args.has("--help")) {
    console.log("node update-runner.mjs --compose compose.yaml --image-env image.env [--once] [--offline]\nNeeds Node 22+, Docker Compose, runner.env with JL_RUNNER_MANAGED_UPDATES=1, and image.env with JL_RUNNER_IMAGE + JL_RUNNER_IMAGE_TAG.");
    return;
  }
  const compose = resolve(args.get("--compose") ?? new URL("compose.yaml", import.meta.url).pathname);
  const imageEnv = resolve(args.get("--image-env") ?? `${dirname(compose)}/image.env`);
  const settings = Object.fromEntries(readFileSync(imageEnv, "utf8").split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
  const image = settings.JL_RUNNER_IMAGE;
  if (!image || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(image) || image.includes("@") || /:[^/]+$/.test(image)) throw new Error("Set JL_RUNNER_IMAGE to a repository without a tag/digest in image.env");
  if (!releaseVersion.test(settings.JL_RUNNER_IMAGE_TAG ?? "")) throw new Error("Pin JL_RUNNER_IMAGE_TAG to a release version in image.env");
  const lock = `${imageEnv}.lock`;
  // One supervisor per deployment, with recovery after a crash/reboot.
  try { mkdirSync(lock); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(readFileSync(`${lock}/pid`, "utf8"));
    try { process.kill(pid, 0); throw new Error("A runner updater is already running for this deployment"); }
    catch (probe) { if (probe.code !== "ESRCH") throw probe; }
    rmSync(lock, { recursive: true }); mkdirSync(lock);
  }
  writeFileSync(`${lock}/pid`, String(process.pid));
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    do {
      try {
        const updated = await updateOnce({ compose, imageEnv, image, offline: args.has("--offline") });
        if (updated) console.log(`Updated runner deployment to ${updated}`);
      } catch (error) {
        // Docker exceptions can include captured output. Never print worker state or tokens.
        console.error(error.status !== undefined ? `Docker command failed (exit ${error.status}); update remains pending` : error.message);
        if (args.has("--once")) throw new Error("Runner update failed");
      }
      if (!args.has("--once") && !stopping) await new Promise(resolve => setTimeout(resolve, 15_000));
    } while (!args.has("--once") && !stopping);
  } finally { rmSync(lock, { recursive: true, force: true }); process.off("SIGTERM", stop); process.off("SIGINT", stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
