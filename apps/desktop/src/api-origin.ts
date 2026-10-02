// Backend and web origins, fixed at build time by scripts/build.ts for both the renderer and the
// Electron main process.
export const desktopApiOrigin = (process.env.JITTLE_LAMP_API_ORIGIN?.trim() || "http://127.0.0.1:3001").replace(/\/+$/, "");
export const desktopWebOrigin = (process.env.JITTLE_LAMP_WEB_ORIGIN?.trim() || "http://127.0.0.1:4173").replace(/\/+$/, "");
