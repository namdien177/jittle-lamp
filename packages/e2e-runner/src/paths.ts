import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Locations that must resolve the same from src/ (bun, tests) and dist/ (node bin, Docker).

function findUp(start: string, matches: (dir: string) => boolean): string {
  let dir = start;
  for (;;) {
    if (matches(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`not found above ${start}`);
    dir = parent;
  }
}

export const runnerPackageDir = findUp(dirname(fileURLToPath(import.meta.url)), (dir) => {
  const path = join(dir, "package.json");
  return existsSync(path) && (JSON.parse(readFileSync(path, "utf8")) as { name?: string }).name === "@jittle-lamp/e2e-runner";
});

// TypeScript modules the generated e2e project imports; e2e loads them with its own TS loader.
export const runtimeDir = join(runnerPackageDir, "src", "runtime");

// `e2e` exports no package.json, so resolve its entry and walk up to the package root.
export const e2ePackageDir = findUp(dirname(fileURLToPath(import.meta.resolve("e2e"))), (dir) => {
  const path = join(dir, "package.json");
  return existsSync(path) && (JSON.parse(readFileSync(path, "utf8")) as { name?: string }).name === "e2e";
});

export const runnerVersion: string = (JSON.parse(readFileSync(join(runnerPackageDir, "package.json"), "utf8")) as { version: string }).version;
export const engineVersion: string = (JSON.parse(readFileSync(join(e2ePackageDir, "package.json"), "utf8")) as { version: string }).version;
