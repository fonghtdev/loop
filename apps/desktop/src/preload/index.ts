import { contextBridge, ipcRenderer } from "electron";
import type { LoopApi } from "./api";

const api: LoopApi = {
  session: {
    get: () => ipcRenderer.invoke("session:get"),
    set: (token) => ipcRenderer.invoke("session:set", token),
    clear: () => ipcRenderer.invoke("session:clear"),
  },
  media: { ensureAccess: (kind) => ipcRenderer.invoke("media:ensureAccess", kind) },
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  version: () => ipcRenderer.invoke("app:version"),
  platform: process.platform,
};

contextBridge.exposeInMainWorld("loop", api);
