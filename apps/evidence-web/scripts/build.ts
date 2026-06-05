/// <reference types="bun-types" />

import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const workspaceRoot = new URL("../../../", import.meta.url);
const distRoot = new URL("../dist/", import.meta.url);

function getWorkspaceEnvValue(name: string): string {
  const currentValue = process.env[name];
  if (currentValue) return currentValue;

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
  naming: "[name].js",
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

await Promise.all([
  Bun.write(new URL("index.html", distRoot), indexHtml),
  Bun.write(
    new URL("index.css", distRoot),
    Bun.file(new URL("../src/index.css", import.meta.url))
  ),
  Bun.write(
    new URL("img-prev.png", distRoot),
    Bun.file(new URL("../assets/img-prev.png", import.meta.url))
  ),
  Bun.write(
    new URL("logo.jpg", distRoot),
    Bun.file(new URL("../../../assets/jittle-lamp-logo.jpg", import.meta.url))
  )
]);

console.info(`Built evidence-web into ${distRoot.pathname}`);
