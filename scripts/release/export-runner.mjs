#!/usr/bin/env node
// Build once on a development/CI machine. Cloud hosts receive an image archive, not a checkout.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const root = resolve(new URL("../..", import.meta.url).pathname);
const { version } = JSON.parse(readFileSync(join(root, "packages/e2e-runner/package.json"), "utf8"));
const out = resolve(process.argv[2] ?? join(root, "release-artifacts", `runner-${version}`));
const image = `jittle-lamp/e2e-runner:${version}`;
mkdirSync(out, { recursive: true });
execFileSync("docker", ["build", "-f", "deploy/runner/Dockerfile", "-t", image, "."], { cwd: root, stdio: "inherit" });
const archive = join(out, `jittle-lamp-e2e-runner-${version}.docker.tar.gz`);
const save = spawn("docker", ["save", image], { stdio: ["ignore", "pipe", "inherit"] });
const completed = new Promise((resolve, reject) => {
  save.on("error", reject); save.on("close", code => code === 0 ? resolve() : reject(new Error(`docker save exited ${code}`)));
});
await Promise.all([pipeline(save.stdout, createGzip(), createWriteStream(archive)), completed]);
const hash = createHash("sha256");
for await (const chunk of createReadStream(archive)) hash.update(chunk);
writeFileSync(`${archive}.sha256`, `${hash.digest("hex")}  ${archive.split("/").pop()}\n`);
for (const name of ["compose.yaml", "runner.env.sample", "update-runner.mjs", "docker-pull.mjs"]) copyFileSync(join(root, "deploy/runner", name), join(out, name));
writeFileSync(join(out, "image.env"), `JL_RUNNER_IMAGE=jittle-lamp/e2e-runner\nJL_RUNNER_IMAGE_TAG=${version}\n`);
writeFileSync(join(out, "README.txt"), `Verify: sha256sum -c ${archive.split("/").pop()}.sha256\nLoad: docker load -i ${archive.split("/").pop()}\nCopy runner.env.sample to runner.env and set API origin + registration token.\nStart: docker compose --env-file image.env -f compose.yaml up -d\nManaged offline updates: enable JL_RUNNER_MANAGED_UPDATES=1 in runner.env, load the next image, and run node update-runner.mjs --offline\nArchitecture: this image uses the build machine's Docker platform. Build/export separately for other architectures.\n`);
console.log(archive);
