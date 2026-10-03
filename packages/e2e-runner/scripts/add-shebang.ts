import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// `bun build --target node` drops the source shebang; the bins need one to run as `jl-e2e`.
for (const name of ["cli.js", "daemon.js"]) {
  const path = join(import.meta.dir, "../dist", name);
  try {
    const body = readFileSync(path, "utf8");
    if (!body.startsWith("#!")) writeFileSync(path, `#!/usr/bin/env node\n${body}`);
  } catch {
    // daemon.js exists from unit 1b.1 on
  }
}
