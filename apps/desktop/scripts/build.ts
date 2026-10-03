import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const workspaceRoot = new URL("../../../", import.meta.url);
const distRoot = new URL("../dist/", import.meta.url);
const electronRoot = new URL("./electron/", distRoot);
const viewsRoot = new URL("./views/mainview/", distRoot);
const cliBuildEnv = process.argv.find((arg) => arg.startsWith("--env="))?.split("=")[1];
const requestedBuildEnv = process.env.JITTLE_LAMP_DESKTOP_BUILD_ENV ?? process.env.ELECTRON_BUILD_ENV ?? cliBuildEnv ?? "dev";
const buildEnv = ["dev", "canary", "stable"].includes(requestedBuildEnv) ? requestedBuildEnv : "dev";
const nodeEnv = buildEnv === "dev" ? "development" : "production";

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

const clerkPublishableKey = getWorkspaceEnvValue("CLERK_PUBLISHABLE_KEY");
const apiOrigin = getWorkspaceEnvValue("JITTLE_LAMP_API_ORIGIN");
const webOrigin = getWorkspaceEnvValue("JITTLE_LAMP_WEB_ORIGIN");
const observabilityBasePath = getFirstWorkspaceEnvValue([
  "REACT_APP_VERCEL_OBSERVABILITY_BASEPATH",
  "VERCEL_OBSERVABILITY_BASEPATH"
]);
const observabilityClientConfig = getFirstWorkspaceEnvValue([
  "REACT_APP_VERCEL_OBSERVABILITY_CLIENT_CONFIG",
  "VERCEL_OBSERVABILITY_CLIENT_CONFIG"
]);

if (buildEnv === "stable") {
  const missing = [
    ["CLERK_PUBLISHABLE_KEY", clerkPublishableKey],
    ["JITTLE_LAMP_API_ORIGIN", apiOrigin]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing required stable desktop build environment: ${missing.join(", ")}. ` +
        "Set these in the shell, the workspace .env for local packaging, or GitHub Actions environment secrets for release builds."
    );
  }
}

const browserDefines = {
  "process.env.CLERK_PUBLISHABLE_KEY": JSON.stringify(clerkPublishableKey),
  "process.env.JITTLE_LAMP_API_ORIGIN": JSON.stringify(apiOrigin),
  "process.env.JITTLE_LAMP_WEB_ORIGIN": JSON.stringify(webOrigin),
  "process.env.REACT_APP_VERCEL_OBSERVABILITY_BASEPATH": JSON.stringify(observabilityBasePath),
  "process.env.REACT_APP_VERCEL_OBSERVABILITY_CLIENT_CONFIG": JSON.stringify(observabilityClientConfig),
  "process.env.NODE_ENV": JSON.stringify(nodeEnv)
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

const [mainBuild, preloadBuild, viewBuild] = await Promise.all([
  Bun.build({
    entrypoints: [new URL("../src/electron/main.ts", import.meta.url).pathname],
    outdir: electronRoot.pathname,
    target: "node",
    format: "esm",
    // The main process fetches evidence playback links from the same API origin as the renderer.
    define: {
      "process.env.JITTLE_LAMP_API_ORIGIN": JSON.stringify(apiOrigin),
      "process.env.JITTLE_LAMP_WEB_ORIGIN": JSON.stringify(webOrigin)
    },
    external: ["electron", "libsql", "@libsql/*"],
    minify: nodeEnv === "production",
    naming: "[name].js"
  }),
  Bun.build({
    entrypoints: [new URL("../src/electron/preload.ts", import.meta.url).pathname],
    outdir: electronRoot.pathname,
    target: "node",
    format: "esm",
    external: ["electron"],
    minify: nodeEnv === "production",
    naming: "[name].js"
  }),
  Bun.build({
    entrypoints: [new URL("../src/mainview/app.tsx", import.meta.url).pathname],
    outdir: viewsRoot.pathname,
    target: "browser",
    format: "esm",
    define: browserDefines,
    plugins: [dedupeReactPlugin],
    minify: nodeEnv === "production",
    naming: "[name].js"
  })
]);

if (!mainBuild.success || !preloadBuild.success || !viewBuild.success) {
  for (const log of [...mainBuild.logs, ...preloadBuild.logs, ...viewBuild.logs]) {
    console.error(log);
  }

  process.exit(1);
}

await Promise.all([
  Bun.write(
    new URL("index.html", viewsRoot),
    Bun.file(new URL("../src/mainview/index.html", import.meta.url))
  ),
  Bun.write(
    new URL("index.css", viewsRoot),
    Bun.file(new URL("../src/mainview/index.css", import.meta.url))
  ),
  Bun.write(
    new URL("logo.jpg", viewsRoot),
    Bun.file(new URL("../../../assets/jittle-lamp-logo.jpg", import.meta.url))
  )
]);

console.info(`Built desktop shell scaffold into ${distRoot.pathname}`);
