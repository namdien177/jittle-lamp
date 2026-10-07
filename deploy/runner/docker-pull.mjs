import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

// Only expose byte counts. Docker/registry messages may contain credential-bearing URLs.
export function createPullProgress() {
  const layers = new Map();
  return event => {
    if (event.id && (layers.has(event.id) || ["Pulling fs layer", "Downloading", "Already exists", "Waiting"].includes(event.status)) && ["Pulling fs layer", "Waiting", "Downloading", "Download complete", "Already exists", "Extracting", "Pull complete"].includes(event.status)) {
      const layer = layers.get(event.id) ?? { current: 0, total: null, cached: false, done: false };
      if (event.status === "Already exists") layer.cached = true;
      if (event.status === "Downloading" && event.progressDetail?.total > 0) {
        layer.total = event.progressDetail.total;
        layer.current = Math.min(layer.total, Math.max(layer.current, event.progressDetail.current ?? 0));
      }
      if (["Download complete", "Extracting", "Pull complete"].includes(event.status)) layer.done = true;
      layers.set(event.id, layer);
    }
    const values = [...layers.values()].filter(layer => !layer.cached);
    const known = layers.size > 0 && values.every(layer => layer.total !== null);
    const totalBytes = known ? values.reduce((sum, layer) => sum + layer.total, 0) : null;
    const downloadedBytes = known ? values.reduce((sum, layer) => sum + (layer.done ? layer.total : layer.current), 0) : null;
    return {
      downloadPercent: totalBytes > 0 ? Math.min(100, Math.floor(downloadedBytes * 100 / totalBytes)) : null,
      downloadedBytes: totalBytes > 0 ? downloadedBytes : null,
      totalBytes: totalBytes > 0 ? totalBytes : null
    };
  };
}

export function runDocker(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", chunk => { output = (output + chunk).slice(-2 * 1024 * 1024); });
    child.on("error", () => reject(new Error("Docker command failed")));
    child.on("close", code => code === 0 ? resolve(output.trim()) : reject(new Error("Docker command failed")));
  });
}

function registryAuth(image) {
  const first = image.split("/")[0];
  const server = first.includes(".") || first.includes(":") || first === "localhost" ? first : "https://index.docker.io/v1/";
  let config;
  try { config = JSON.parse(readFileSync(join(process.env.DOCKER_CONFIG ?? join(homedir(), ".docker"), "config.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("Unable to read Docker registry credentials"); return {}; }
  const helper = config.credHelpers?.[server] ?? config.credsStore;
  if (helper) {
    if (!/^[A-Za-z0-9._-]+$/.test(helper)) throw new Error("Invalid Docker credential helper");
    let credentials;
    try { credentials = JSON.parse(execFileSync(`docker-credential-${helper}`, ["get"], { input: `${server}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })); }
    catch { throw new Error("Unable to read Docker registry credentials"); }
    return credentials.Username === "<token>" ? { identitytoken: credentials.Secret, serveraddress: server }
      : { username: credentials.Username, password: credentials.Secret, serveraddress: server };
  }
  const auth = config.auths?.[server] ?? config.auths?.[`https://${server}`] ?? {};
  if (auth.identitytoken) return { identitytoken: auth.identitytoken, serveraddress: server };
  if (!auth.auth) return {};
  const decoded = Buffer.from(auth.auth, "base64").toString("utf8");
  const at = decoded.indexOf(":");
  return { username: decoded.slice(0, at), password: decoded.slice(at + 1), serveraddress: server };
}

export async function pullImage(image, onProgress) {
  let host = process.env.DOCKER_HOST;
  if (process.env.DOCKER_CONTEXT || !host) {
    host = JSON.parse(execFileSync("docker", ["context", "inspect", ...(process.env.DOCKER_CONTEXT ? [process.env.DOCKER_CONTEXT] : []), "--format", "{{json .Endpoints.docker.Host}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  }
  // Remote/TLS contexts still update safely, with an indeterminate download indicator.
  if (!host.startsWith("unix://")) { await runDocker(["pull", image]); return; }
  const at = image.lastIndexOf(":");
  const auth = Buffer.from(JSON.stringify(registryAuth(image))).toString("base64url");
  const consume = createPullProgress();
  await new Promise((resolve, reject) => {
    const req = request({ socketPath: host.slice(7), method: "POST",
      path: `/images/create?fromImage=${encodeURIComponent(image.slice(0, at))}&tag=${encodeURIComponent(image.slice(at + 1))}`,
      headers: { "X-Registry-Auth": auth } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error("Docker image download failed")); return; }
      let pending = "";
      const handle = line => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch { throw new Error("Invalid Docker progress response"); }
        if (event.error || event.errorDetail) throw new Error("Docker image download failed");
        onProgress(consume(event));
      };
      res.setEncoding("utf8");
      res.on("data", chunk => {
        try {
          pending += chunk;
          let newline;
          while ((newline = pending.indexOf("\n")) !== -1) { handle(pending.slice(0, newline)); pending = pending.slice(newline + 1); }
          if (pending.length > 1024 * 1024) throw new Error("Invalid Docker progress response");
        } catch { req.destroy(new Error("Docker image download failed")); }
      });
      res.on("end", () => { try { handle(pending); resolve(); } catch { reject(new Error("Docker image download failed")); } });
      res.on("error", () => reject(new Error("Docker image download failed")));
    });
    req.setTimeout(120_000, () => req.destroy(new Error("Docker image download timed out")));
    req.on("error", () => reject(new Error("Docker image download failed")));
    req.end();
  });
}
