/// <reference types="bun-types" />

import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const workspaceRoot = new URL("../../../", import.meta.url);
const distRoot = new URL("../dist/", import.meta.url);

function getWorkspaceEnvValue(name: string): string {
  if (process.env[name] !== undefined) return process.env[name] ?? "";

  const envFile = new URL(".env", workspaceRoot);
  if (!existsSync(envFile)) return "";

  return parseEnv(readFileSync(envFile, "utf8"))[name] ?? "";
}

function getFirstWorkspaceEnvValue(names: string[]): string {
  for (const name of names) {
    const value = getWorkspaceEnvValue(name);
    if (value) return value;
  }

  return "";
}

function getWebApiOrigin(): string {
  const configuredOrigin = getWorkspaceEnvValue("JITTLE_LAMP_API_ORIGIN");
  if (configuredOrigin) return configuredOrigin;

  return process.env.VERCEL ? "/api" : "";
}

const browserDefines = {
  "process.env.CLERK_PUBLISHABLE_KEY": JSON.stringify(getWorkspaceEnvValue("CLERK_PUBLISHABLE_KEY")),
  "process.env.JITTLE_LAMP_API_ORIGIN": JSON.stringify(getWebApiOrigin()),
  "process.env.JITTLE_LAMP_DEV_AUTH_ENABLED": JSON.stringify(getWorkspaceEnvValue("JITTLE_LAMP_DEV_AUTH_ENABLED")),
  "process.env.JITTLE_LAMP_DEV_AUTH_TOKEN": JSON.stringify(getWorkspaceEnvValue("JITTLE_LAMP_DEV_AUTH_TOKEN")),
  "process.env.JITTLE_LAMP_DEV_AUTH_USER_ID": JSON.stringify(getWorkspaceEnvValue("JITTLE_LAMP_DEV_AUTH_USER_ID")),
  "process.env.JITTLE_LAMP_DEV_AUTH_EMAIL": JSON.stringify(getWorkspaceEnvValue("JITTLE_LAMP_DEV_AUTH_EMAIL")),
  "process.env.JITTLE_LAMP_DEV_AUTH_NAME": JSON.stringify(getWorkspaceEnvValue("JITTLE_LAMP_DEV_AUTH_NAME")),
  "process.env.REACT_APP_VERCEL_OBSERVABILITY_BASEPATH": JSON.stringify(getFirstWorkspaceEnvValue([
    "REACT_APP_VERCEL_OBSERVABILITY_BASEPATH",
    "VERCEL_OBSERVABILITY_BASEPATH"
  ])),
  "process.env.REACT_APP_VERCEL_OBSERVABILITY_CLIENT_CONFIG": JSON.stringify(getFirstWorkspaceEnvValue([
    "REACT_APP_VERCEL_OBSERVABILITY_CLIENT_CONFIG",
    "VERCEL_OBSERVABILITY_CLIENT_CONFIG"
  ])),
  "process.env.VERCEL": JSON.stringify(process.env.VERCEL ?? ""),
  "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production")
};

const reactEntrypoints = new Map([
  ["react", new URL("node_modules/react/index.js", workspaceRoot).pathname],
  ["react/jsx-runtime", new URL("node_modules/react/jsx-runtime.js", workspaceRoot).pathname],
  ["react/jsx-dev-runtime", new URL("node_modules/react/jsx-dev-runtime.js", workspaceRoot).pathname]
]);

const dedupeReactPlugin = {
  name: "dedupe-react",
  setup(build: {
    onResolve: (
      options: { filter: RegExp },
      callback: (args: { path: string }) => { path: string } | undefined
    ) => void;
  }) {
    build.onResolve({ filter: /^react(?:\/jsx-runtime|\/jsx-dev-runtime)?$/ }, (args) => {
      const path = reactEntrypoints.get(args.path);
      return path ? { path } : undefined;
    });
  }
};

const build = await Bun.build({
  entrypoints: [new URL("../src/app.ts", import.meta.url).pathname],
  outdir: distRoot.pathname,
  target: "browser",
  format: "esm",
  define: browserDefines,
  plugins: [dedupeReactPlugin],
  naming: { entry: "[name].js", chunk: "chunks/[name]-[hash].js", asset: "[name]-[hash].[ext]" },
  splitting: true,
  minify: true
});

if (!build.success) {
  for (const log of build.logs) {
    console.error(log);
  }
  process.exit(1);
}

const previewOrigin = getWorkspaceEnvValue("JITTLE_LAMP_WEB_ORIGIN").replace(/\/+$/, "");
const indexHtmlSource = await Bun.file(new URL("../src/index.html", import.meta.url)).text();
const indexHtml = previewOrigin
  ? indexHtmlSource.replaceAll("/img-prev.png", `${previewOrigin}/img-prev.png`)
  : indexHtmlSource;

// Compile Tailwind (v4). The entry imports the legacy viewer stylesheet, so the
// emitted dist/index.css contains both the generated utilities and the styles
// the embedded viewer depends on.
const cssInput = new URL("../src/index.css", import.meta.url).pathname;
const cssOutput = new URL("index.css", distRoot).pathname;
const tailwind = Bun.spawnSync(
  ["bunx", "@tailwindcss/cli", "--input", cssInput, "--output", cssOutput, "--minify"],
  { cwd: new URL("../", import.meta.url).pathname, stdout: "inherit", stderr: "inherit" }
);
if (tailwind.exitCode !== 0) {
  console.error("Tailwind CSS build failed.");
  process.exit(1);
}

await Promise.all([
  Bun.write(new URL("index.html", distRoot), indexHtml),
  Bun.write(
    new URL("img-prev.png", distRoot),
    Bun.file(new URL("../assets/img-prev.png", import.meta.url))
  ),
  Bun.write(
    new URL("logo.jpg", distRoot),
    Bun.file(new URL("../../../assets/jittle-lamp-logo.jpg", import.meta.url))
  ),
  Bun.write(
    new URL("llms.txt", distRoot),
    Bun.file(new URL("../src/llms.txt", import.meta.url))
  )
]);

console.info(`Built evidence-web into ${distRoot.pathname}`);
