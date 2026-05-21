import { extensionManifest } from "./manifest";

const outdir = new URL("../dist/", import.meta.url);
const apiOrigin = (process.env.JITTLE_LAMP_API_ORIGIN?.trim() || "https://jl-api.monthlyparty.com").replace(/\/+$/, "");

const result = await Bun.build({
  entrypoints: [
    new URL("../src/background.ts", import.meta.url).pathname,
    new URL("../src/content.ts", import.meta.url).pathname,
    new URL("../src/network-probe.ts", import.meta.url).pathname,
    new URL("../src/offscreen.ts", import.meta.url).pathname,
    new URL("../src/popup.ts", import.meta.url).pathname
  ],
  outdir: outdir.pathname,
  target: "browser",
  format: "esm",
  sourcemap: "linked",
  naming: "[name].js",
  define: {
    __JITTLE_LAMP_API_ORIGIN__: JSON.stringify(apiOrigin)
  }
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }

  process.exit(1);
}

await Bun.write(
  new URL("manifest.json", outdir),
  `${JSON.stringify(extensionManifest, null, 2)}\n`
);

await Promise.all([
  Bun.write(
    new URL("popup.html", outdir),
    Bun.file(new URL("../src/popup.html", import.meta.url))
  ),
  Bun.write(
    new URL("popup.css", outdir),
    Bun.file(new URL("../src/popup.css", import.meta.url))
  ),
  Bun.write(
    new URL("offscreen.html", outdir),
    Bun.file(new URL("../src/offscreen.html", import.meta.url))
  ),
  Bun.write(
    new URL("icon.jpeg", outdir),
    Bun.file(new URL("../../../assets/jittle-lamp-extension-icon.jpg", import.meta.url))
  )
]);

console.info(`Built extension assets into ${outdir.pathname}`);
