import { contextBridge, ipcRenderer } from "electron";
import { isConversationKey } from "../shared/notify";
import { parseUpdateStatus } from "../shared/update";
import type { LoopApi } from "./api";

const api: LoopApi = {
  session: {
    get: () => ipcRenderer.invoke("session:get"),
    set: (token) => ipcRenderer.invoke("session:set", token),
    clear: () => ipcRenderer.invoke("session:clear"),
  },
  media: { ensureAccess: (kind) => ipcRenderer.invoke("media:ensureAccess", kind) },
  settings: { get: () => ipcRenderer.invoke("settings:get"), set: (patch) => ipcRenderer.invoke("settings:set", patch) },
  update: {
    get: () => ipcRenderer.invoke("update:get"),
    check: () => ipcRenderer.invoke("update:check"),
    install: () => ipcRenderer.invoke("update:install"),
    onStatus: (cb) => {
      const listener = (_e: unknown, status: unknown) => cb(parseUpdateStatus(status));
      ipcRenderer.on("update:status", listener);
      return () => void ipcRenderer.removeListener("update:status", listener);
    },
  },
  notify: (payload) => ipcRenderer.invoke("notify:show", payload),
  closeNotification: (key) => ipcRenderer.invoke("notify:close", key),
  onNavigate: (cb) => {
    const listener = (_e: unknown, key: unknown) => isConversationKey(key) && cb(key);
    ipcRenderer.on("notification:navigate", listener);
    return () => void ipcRenderer.removeListener("notification:navigate", listener);
  },
  setBadge: (count) => ipcRenderer.invoke("badge:set", count),
  onFocusChange: (cb) => {
    const listener = (_e: unknown, focused: unknown) => cb(focused === true);
    ipcRenderer.on("window:focus", listener);
    return () => void ipcRenderer.removeListener("window:focus", listener);
  },
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  version: () => ipcRenderer.invoke("app:version"),
  platform: process.platform,
  e2e: process.argv.includes("--loop-e2e"),
};

contextBridge.exposeInMainWorld("loop", api);
