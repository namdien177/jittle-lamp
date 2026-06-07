import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  recordingFileName,
  sessionArchiveFileName
} from "@jittle-lamp/shared";

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions,
  type OpenDialogOptions
} from "electron";

import { loadResolvedCompanionConfig, saveCompanionConfig } from "../companion/config";
import {
  deleteSession,
  getCompanionConfigState,
  getCompanionRuntimeState,
  refreshCompanionConfig,
  registerMediaPlayback,
  startCompanionServer
} from "../companion/server";
import {
  addSessionTag,
  getSessionNotes,
  listAllTags,
  loadLibrarySession,
  markSessionRemoteSynced,
  removeSessionTag,
  saveLibrarySessionReviewState,
  scanLibrarySessions,
  setSessionNotes
} from "../companion/sessions-db";
import {
  desktopIpcMessageChannel,
  desktopIpcRequestChannel,
  type ContextMenuItem,
  type DesktopCompanionConfigSnapshot,
  type DesktopCompanionRuntimeSnapshot,
  type DesktopUpdateState,
  type DesktopRendererMessageMap,
  type DesktopRequestMap
} from "../rpc";
import { buildSessionZip, clearTempSession, importZipBundle, loadLocalSession } from "../session/zip-import";

type DesktopHandler<K extends keyof DesktopRequestMap> = (
  params: DesktopRequestMap[K]["params"]
) => Promise<DesktopRequestMap[K]["response"]> | DesktopRequestMap[K]["response"];

type DesktopHandlerMap = {
  [K in keyof DesktopRequestMap]: DesktopHandler<K>;
};

type DesktopRequestPayload = {
  name?: string;
  params?: unknown;
};

type DesktopMessagePayload<K extends keyof DesktopRendererMessageMap = keyof DesktopRendererMessageMap> = {
  name: K;
  payload: DesktopRendererMessageMap[K];
};

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const preloadPath = join(currentDir, "preload.js");
const mainViewPath = join(currentDir, "..", "views", "mainview", "index.html");
const macosDesktopInstallScriptUrl =
  "https://raw.githubusercontent.com/namdien177/jittle-lamp/main/scripts/release/install-macos-desktop.sh";
const latestReleaseApiUrl = "https://api.github.com/repos/namdien177/jittle-lamp/releases/latest";

let mainWindow: BrowserWindow | null = null;
let desktopUpdateState: DesktopUpdateState = createInitialDesktopUpdateState();

const handlers: DesktopHandlerMap = {
  addSessionTag: async ({ sessionId, tag }) => {
    addSessionTag(sessionId, tag);
    return { ok: true as const };
  },
  chooseOutputDirectory: async ({ startingFolder }) => {
    const result = await showOpenDialog({
      defaultPath: startingFolder || homedir(),
      properties: ["openDirectory"]
    });

    return {
      selectedPath: result.canceled ? null : result.filePaths[0] ?? null
    };
  },
  clearTempSession: async ({ tempId }) => {
    await clearTempSession(tempId);
    return { ok: true as const };
  },
  deleteSession: async ({ sessionId }) => {
    await deleteSession(sessionId);
    return { ok: true as const };
  },
  exitApp: async () => {
    queueMicrotask(() => {
      app.quit();
    });

    return { ok: true as const };
  },
  exportSessionZip: async ({ sessionId }) => {
    const config = await getCompanionConfigState();
    const safeOutputDir = resolve(config.outputDir);
    const sessionFolder = resolve(join(safeOutputDir, sessionId));

    if (!sessionFolder.startsWith(`${safeOutputDir}/`) && sessionFolder !== safeOutputDir) {
      throw new Error("Invalid sessionId: path traversal detected.");
    }

    const zipBytes = await buildSessionZip(sessionFolder);
    const result = await showOpenDialog({
      defaultPath: homedir(),
      properties: ["openDirectory"]
    });

    const saveDir = result.canceled ? null : result.filePaths[0] ?? null;
    if (!saveDir) throw new Error("No save directory selected.");

    const savedPath = join(saveDir, `${sessionId}.zip`);
    await writeFile(savedPath, zipBytes);

    return { savedPath };
  },
  prepareSessionUpload: async ({ sessionId }) => {
    const config = await getCompanionConfigState();
    const safeOutputDir = resolve(config.outputDir);
    const sessionFolder = resolve(join(safeOutputDir, sessionId));

    if (!sessionFolder.startsWith(`${safeOutputDir}/`) && sessionFolder !== safeOutputDir) {
      throw new Error("Invalid sessionId: path traversal detected.");
    }

    const [recordingPayload, archivePayload, playbackPayload] = await Promise.all([
      readFile(join(sessionFolder, recordingFileName)),
      readFile(join(sessionFolder, sessionArchiveFileName)),
      readFile(join(sessionFolder, "recording.mp4")).catch(() => null)
    ]);
    const recordingBytes = new Uint8Array(recordingPayload);
    const archiveBytes = new Uint8Array(archivePayload);
    const playbackBytes = playbackPayload ? new Uint8Array(playbackPayload) : null;
    return {
      sessionId,
      title: sessionId,
      artifacts: [
        {
          key: "recording" as const,
          kind: "recording" as const,
          mimeType: "video/webm",
          bytes: recordingBytes.byteLength,
          checksum: `sha256:${await sha256Hex(recordingBytes)}`,
          payload: recordingBytes
        },
        ...(playbackBytes
          ? [
              {
                key: "playback" as const,
                kind: "recording" as const,
                mimeType: "video/mp4",
                bytes: playbackBytes.byteLength,
                checksum: `sha256:${await sha256Hex(playbackBytes)}`,
                payload: playbackBytes
              }
            ]
          : []),
        {
          key: "archive" as const,
          kind: "network-log" as const,
          mimeType: "application/json",
          bytes: archiveBytes.byteLength,
          checksum: `sha256:${await sha256Hex(archiveBytes)}`,
          payload: archiveBytes
        }
      ]
    };
  },
  markSessionRemoteSynced: async ({ sessionId, evidenceId, orgId }) => {
    markSessionRemoteSynced({ sessionId, evidenceId, orgId });
    return { ok: true as const };
  },
  getCompanionConfig: async () => toDesktopCompanionConfigSnapshot(await refreshCompanionConfig()),
  getCompanionRuntime: async () => toDesktopCompanionRuntimeSnapshot(await getCompanionRuntimeState()),
  getDesktopUpdateState: () => desktopUpdateState,
  checkForDesktopUpdate: async () => checkForDesktopUpdate(),
  installDesktopUpdate: async () => {
    if (desktopUpdateState.status !== "available") {
      throw new Error("No desktop update is ready to install.");
    }

    if (process.platform === "darwin") {
      await launchMacosInstallerInBackground(desktopUpdateState.availableVersion);

      queueMicrotask(() => {
        app.quit();
      });

      return { ok: true as const };
    }

    throw new Error("Desktop update install is currently supported only on macOS.");
  },
  getSessionNotes: async ({ sessionId }) => {
    return { notes: getSessionNotes(sessionId) };
  },
  getVideoPlaybackUrl: async ({ videoPath, mimeType }) => {
    return { url: registerMediaPlayback({ filePath: videoPath, mimeType }) };
  },
  importZipSession: async () => {
    const result = await showOpenDialog({
      defaultPath: homedir(),
      filters: [{ name: "ZIP archives", extensions: ["zip"] }],
      properties: ["openFile"]
    });

    const selectedPath = result.canceled ? null : result.filePaths[0] ?? null;
    if (!selectedPath) throw new Error("No ZIP file selected.");

    return importZipBundle(new Uint8Array(await readFile(selectedPath)));
  },
  listAllTags: async () => listAllTags(),
  listSessions: async () => {
    const config = await getCompanionConfigState();
    return scanLibrarySessions(config.outputDir);
  },
  loadLibrarySession: async ({ sessionId }) => {
    const config = await getCompanionConfigState();
    return loadLibrarySession(sessionId, config.outputDir);
  },
  openLocalSession: async () => {
    const result = await showOpenDialog({
      defaultPath: homedir(),
      properties: ["openDirectory"]
    });

    const selectedPath = result.canceled ? null : result.filePaths[0] ?? null;
    if (!selectedPath) throw new Error("No folder selected.");

    return loadLocalSession(selectedPath);
  },
  openPath: async ({ path }) => {
    const openError = await shell.openPath(path);
    if (openError) {
      throw new Error(openError);
    }

    return {
      ok: true as const
    };
  },
  openExternalUrl: async ({ url }) => {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      throw new Error("Only HTTP(S) URLs can be opened externally.");
    }

    await shell.openExternal(parsedUrl.toString());
    return {
      ok: true as const
    };
  },
  removeSessionTag: async ({ sessionId, tag }) => {
    removeSessionTag(sessionId, tag);
    return { ok: true as const };
  },
  saveOutputDirectory: async ({ outputDir }) => {
    const currentConfig = await loadResolvedCompanionConfig();

    if (currentConfig.envOverrideActive) {
      throw new Error(
        "JITTLE_LAMP_OUTPUT_DIR is set. Remove the environment override before editing the saved output folder."
      );
    }

    await saveCompanionConfig({ autoSyncToCloud: currentConfig.autoSyncToCloud, outputDir });

    return toDesktopCompanionConfigSnapshot(await refreshCompanionConfig());
  },
  saveAutoSyncToCloud: async ({ autoSyncToCloud }) => {
    const currentConfig = await loadResolvedCompanionConfig();

    await saveCompanionConfig({ autoSyncToCloud, outputDir: currentConfig.savedOutputDir ?? currentConfig.outputDir });

    return toDesktopCompanionConfigSnapshot(await refreshCompanionConfig());
  },
  saveSessionReviewState: async ({ sessionId, notes, annotations }) => {
    const config = await getCompanionConfigState();
    const archive = await saveLibrarySessionReviewState({
      sessionId,
      outputDir: config.outputDir,
      notes,
      annotations
    });
    return { ok: true as const, archive };
  },
  setSessionNotes: async ({ sessionId, notes }) => {
    setSessionNotes(sessionId, notes);
    return { ok: true as const };
  },
  showContextMenu: async ({ menu }) => {
    showContextMenu(menu);
    return { ok: true as const };
  }
};

app.setName("Jittle Lamp");
registerIpcHandlers();

void app.whenReady().then(async () => {
  await startCompanionServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
  });

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function registerIpcHandlers(): void {
  ipcMain.handle(desktopIpcRequestChannel, async (_event, payload: DesktopRequestPayload) => {
    if (!payload.name || !(payload.name in handlers)) {
      throw new Error(`Unknown desktop request: ${payload.name ?? "(missing)"}`);
    }

    const name = payload.name as keyof DesktopRequestMap;
    const handler = handlers[name] as DesktopHandler<typeof name>;
    return handler(payload.params as never);
  });
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    title: "Jittle Lamp",
    x: 120,
    y: 120,
    width: 1240,
    height: 840,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: false
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  void mainWindow.loadFile(mainViewPath);
}

function showOpenDialog(options: OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  if (mainWindow) {
    return dialog.showOpenDialog(mainWindow, options);
  }

  return dialog.showOpenDialog(options);
}

async function sha256Hex(payload: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", payload.slice().buffer);
  return Array.from(new Uint8Array(digest))
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function showContextMenu(menu: ContextMenuItem[]): void {
  const template = menu.flatMap((item): MenuItemConstructorOptions[] => {
    if (item.type === "separator") {
      return [{ type: "separator" }];
    }

    if (!item.label) {
      return [];
    }

    const menuItem: MenuItemConstructorOptions = {
      label: item.label,
      type: "normal",
      click: () => {
        if (item.action) {
          sendRendererMessage("contextMenuClicked", {
            action: item.action,
            data: item.data
          });
        }
      }
    };

    if (item.enabled !== undefined) {
      menuItem.enabled = item.enabled;
    }

    return [menuItem];
  });

  if (mainWindow) {
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
    return;
  }

  Menu.buildFromTemplate(template).popup();
}

function sendRendererMessage<K extends keyof DesktopRendererMessageMap>(
  name: K,
  payload: DesktopRendererMessageMap[K]
): void {
  const message: DesktopMessagePayload<K> = {
    name,
    payload
  };

  mainWindow?.webContents.send(desktopIpcMessageChannel, message);
}

function toDesktopCompanionConfigSnapshot(config: Awaited<ReturnType<typeof loadResolvedCompanionConfig>>): DesktopCompanionConfigSnapshot {
  return {
    autoSyncToCloud: config.autoSyncToCloud,
    configFilePath: config.configFilePath,
    defaultOutputDir: config.defaultOutputDir,
    envOverrideActive: config.envOverrideActive,
    outputDir: config.outputDir,
    savedOutputDir: config.savedOutputDir,
    source: config.source
  };
}

function toDesktopCompanionRuntimeSnapshot(
  runtime: Awaited<ReturnType<typeof getCompanionRuntimeState>>
): DesktopCompanionRuntimeSnapshot {
  return {
    status: runtime.status,
    origin: runtime.origin,
    outputDir: runtime.outputDir,
    lastError: runtime.lastError,
    recentWrites: runtime.recentWrites
  };
}

function createInitialDesktopUpdateState(): DesktopUpdateState {
  return {
    status: "idle",
    currentVersion: app.getVersion(),
    availableVersion: null,
    releaseDate: null,
    progressPercent: null,
    lastCheckedAt: null,
    error: null
  };
}

function patchDesktopUpdateState(update: Partial<DesktopUpdateState>): DesktopUpdateState {
  desktopUpdateState = {
    ...desktopUpdateState,
    ...update,
    currentVersion: app.getVersion()
  };
  return desktopUpdateState;
}

async function checkForDesktopUpdate(): Promise<DesktopUpdateState> {
  if (!app.isPackaged) {
    return patchDesktopUpdateState({
      status: "unsupported",
      progressPercent: null,
      lastCheckedAt: new Date().toISOString(),
      error: "Updates are only available in the packaged desktop app."
    });
  }

  if (process.platform !== "darwin") {
    return patchDesktopUpdateState({
      status: "unsupported",
      progressPercent: null,
      lastCheckedAt: new Date().toISOString(),
      error: "Desktop update install is currently supported only on macOS."
    });
  }

  if (desktopUpdateState.status === "checking") {
    return desktopUpdateState;
  }

  try {
    patchDesktopUpdateState({
      status: "checking",
      progressPercent: null,
      lastCheckedAt: new Date().toISOString(),
      error: null
    });
    const latestRelease = await fetchLatestDesktopRelease();
    const latestVersion = normalizeReleaseVersion(latestRelease.tagName);
    const currentVersion = normalizeReleaseVersion(app.getVersion());

    if (!latestVersion || !currentVersion || compareVersions(latestVersion, currentVersion) <= 0) {
      return patchDesktopUpdateState({
        status: "not-available",
        availableVersion: latestVersion ?? latestRelease.tagName,
        releaseDate: latestRelease.publishedAt,
        progressPercent: null,
        lastCheckedAt: new Date().toISOString(),
        error: null
      });
    }

    return patchDesktopUpdateState({
      status: "available",
      availableVersion: latestVersion,
      releaseDate: latestRelease.publishedAt,
      progressPercent: null,
      lastCheckedAt: new Date().toISOString(),
      error: null
    });
  } catch (error) {
    return patchDesktopUpdateState({
      status: "error",
      progressPercent: null,
      lastCheckedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function fetchLatestDesktopRelease(): Promise<{ tagName: string; publishedAt: string | null }> {
  const response = await fetch(latestReleaseApiUrl, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": `Jittle Lamp Desktop/${app.getVersion()}`
    }
  });

  if (!response.ok) {
    throw new Error(`Unable to check the latest desktop release (${response.status}).`);
  }

  const payload = (await response.json()) as {
    tag_name?: unknown;
    published_at?: unknown;
    assets?: unknown;
  };
  if (typeof payload.tag_name !== "string" || payload.tag_name.trim().length === 0) {
    throw new Error("The latest desktop release did not include a valid tag.");
  }

  const assetNames = Array.isArray(payload.assets)
    ? payload.assets
        .map((asset) => (isReleaseAsset(asset) ? asset.name : null))
        .filter((assetName) => assetName !== null)
    : [];
  if (!assetNames.some((assetName) => isMacosDesktopDmg(payload.tag_name as string, assetName))) {
    throw new Error("The latest desktop release does not include a macOS desktop DMG.");
  }

  return {
    tagName: payload.tag_name,
    publishedAt: typeof payload.published_at === "string" ? payload.published_at : null
  };
}

function isReleaseAsset(value: unknown): value is { name: string } {
  return Boolean(value && typeof value === "object" && "name" in value && typeof value.name === "string");
}

function isMacosDesktopDmg(tagName: string, assetName: string): boolean {
  return ["unsigned", "adhoc", "signed"].some(
    (suffix) => assetName === `jittle-lamp-desktop-${tagName}-macos-arm64-${suffix}.dmg`
  );
}

async function launchMacosInstallerInBackground(version: string | null): Promise<void> {
  const command = buildMacosInstallerCommand(version);
  const child = spawn("bash", ["-lc", command], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function buildMacosInstallerCommand(version: string | null): string {
  const tag = normalizeReleaseTag(version);
  const versionPrefix = tag ? `JITTLE_LAMP_VERSION=${shellQuote(tag)} ` : "";
  const installAndReopenCommand = `sleep 2; curl -fsSL ${macosDesktopInstallScriptUrl} | bash && open -a ${shellQuote("Jittle Lamp")}`;
  return `${versionPrefix}bash -lc ${shellQuote(installAndReopenCommand)}`;
}

function normalizeReleaseVersion(version: string | null): string | null {
  const tag = normalizeReleaseTag(version);
  return tag?.slice(1) ?? null;
}

function normalizeReleaseTag(version: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  if (!leftParts || !rightParts) return left.localeCompare(right);

  for (const index of [0, 1, 2] as const) {
    const diff = leftParts[index] - rightParts[index];
    if (diff !== 0) return diff;
  }

  return 0;
}

function parseVersionParts(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
