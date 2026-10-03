import { contextBridge, ipcRenderer } from "electron";

import {
  desktopIpcMessageChannel,
  desktopIpcRequestChannel,
  type DesktopRendererMessageMap,
  type DesktopRequestMap
} from "../rpc";

type DesktopRequestPayload<K extends keyof DesktopRequestMap = keyof DesktopRequestMap> = {
  name: K;
  params: DesktopRequestMap[K]["params"];
};

type DesktopMessagePayload = {
  [K in keyof DesktopRendererMessageMap]: { name: K; payload: DesktopRendererMessageMap[K] };
}[keyof DesktopRendererMessageMap];

const desktopApi = {
  request<K extends keyof DesktopRequestMap>(
    name: K,
    params: DesktopRequestMap[K]["params"]
  ): Promise<DesktopRequestMap[K]["response"]> {
    return ipcRenderer.invoke(desktopIpcRequestChannel, {
      name,
      params
    } satisfies DesktopRequestPayload<K>) as Promise<DesktopRequestMap[K]["response"]>;
  },
  onContextMenuClicked(handler: (data: DesktopRendererMessageMap["contextMenuClicked"]) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, message: DesktopMessagePayload) => {
      if (message.name === "contextMenuClicked") {
        handler(message.payload);
      }
    };

    ipcRenderer.on(desktopIpcMessageChannel, listener);
    return () => {
      ipcRenderer.removeListener(desktopIpcMessageChannel, listener);
    };
  },
  onDeepLinkReceived(handler: () => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, message: DesktopMessagePayload) => {
      if (message.name === "deepLinkReceived") {
        handler();
      }
    };

    ipcRenderer.on(desktopIpcMessageChannel, listener);
    return () => {
      ipcRenderer.removeListener(desktopIpcMessageChannel, listener);
    };
  }
};

contextBridge.exposeInMainWorld("jittleLampDesktop", desktopApi);
