import { join } from "node:path";
import { app, Menu, nativeImage, Tray } from "electron";
import { trayClickAction, trayMenuModel, type TrayItem } from "./policy";

/**
 * Where the tray PNGs are. Development: apps/desktop/resources next to out/. Packaged: step 10 copies the folder to
 * the app's resources directory (electron-builder `extraResources`), which is where `process.resourcesPath` points.
 */
const resourcesDir = () => (app.isPackaged ? process.resourcesPath : join(__dirname, "../../resources"));

type Deps = { notifications: () => boolean; window: () => { visible: boolean; focused: boolean }; onItem: (id: "open" | "notifications" | "quit") => void; onToggle: (action: "show" | "hide") => void };

/** The tray icon (a template image on macOS so the menu bar can tint it) and its menu, rebuilt from the model. */
export function createTray({ notifications, window, onItem, onToggle }: Deps) {
  const icon = nativeImage.createFromPath(join(resourcesDir(), process.platform === "darwin" ? "trayTemplate.png" : "tray.png"));
  const tray = new Tray(icon);
  tray.setToolTip("Loop");
  const build = () =>
    Menu.buildFromTemplate(
      trayMenuModel({ notifications: notifications() }).map((item: TrayItem) =>
        item.id === "separator"
          ? { type: "separator" as const }
          : { label: item.label, type: item.id === "notifications" ? ("checkbox" as const) : ("normal" as const), checked: item.checked, click: () => onItem(item.id) },
      ),
    );
  tray.setContextMenu(build());
  // Windows / Linux: a plain click toggles the window (macOS opens the menu instead)
  tray.on("click", () => onToggle(trayClickAction(window())));
  return { refresh: () => tray.setContextMenu(build()), destroy: () => tray.destroy(), click: () => onToggle(trayClickAction(window())), exists: () => !tray.isDestroyed() };
}
export type TrayHandle = ReturnType<typeof createTray>;
