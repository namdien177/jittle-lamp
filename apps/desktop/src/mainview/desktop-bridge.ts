import type { ContextMenuItem, DesktopRendererMessageMap, DesktopRequestMap } from "../rpc";

export type DesktopBridgeRequestApi = {
  [K in keyof DesktopRequestMap]: (
    params: DesktopRequestMap[K]["params"]
  ) => Promise<DesktopRequestMap[K]["response"]>;
};

export type DesktopBridge = {
  rpc: {
    request: DesktopBridgeRequestApi;
  };
  onContextMenuClicked: (
    handler: (data: DesktopRendererMessageMap["contextMenuClicked"]) => void
  ) => () => void;
  onDeepLinkReceived: (handler: () => void) => () => void;
};

type DesktopPreloadApi = {
  request<K extends keyof DesktopRequestMap>(
    name: K,
    params: DesktopRequestMap[K]["params"]
  ): Promise<DesktopRequestMap[K]["response"]>;
  onContextMenuClicked(
    handler: (data: DesktopRendererMessageMap["contextMenuClicked"]) => void
  ): () => void;
  onDeepLinkReceived?(handler: () => void): () => void;
};

const requestNames = [
  "addSessionTag",
  "chooseOutputDirectory",
  "clearTempSession",
  "consumeDeepLink",
  "deleteSession",
  "exitApp",
  "exportSessionZip",
  "checkForDesktopUpdate",
  "getCompanionConfig",
  "getCompanionRuntime",
  "getDesktopUpdateState",
  "getSessionNotes",
  "getVideoPlaybackUrl",
  "installDesktopUpdate",
  "importZipSession",
  "listAllTags",
  "listSessions",
  "loadLibrarySession",
  "openLocalSession",
  "openPath",
  "openRemoteEvidence",
  "openExternalUrl",
  "markSessionRemoteSynced",
  "prepareSessionUpload",
  "removeSessionTag",
  "saveAutoSyncToCloud",
  "saveOutputDirectory",
  "saveSessionReviewState",
  "setSessionNotes",
  "showContextMenu"
] as const satisfies readonly (keyof DesktopRequestMap)[];

export function createDesktopBridge(): DesktopBridge | null {
  const desktopApi = window.jittleLampDesktop;

  if (!desktopApi) {
    return null;
  }

  const request = Object.fromEntries(
    requestNames.map((name) => [
      name,
      (params: DesktopRequestMap[typeof name]["params"]) => desktopApi.request(name, params)
    ])
  ) as unknown as DesktopBridgeRequestApi;

  return {
    rpc: {
      request
    },
    onContextMenuClicked: desktopApi.onContextMenuClicked,
    onDeepLinkReceived: desktopApi.onDeepLinkReceived ?? (() => () => undefined)
  };
}

declare global {
  interface Window {
    jittleLampDesktop?: DesktopPreloadApi;
  }
}

export type { ContextMenuItem };
