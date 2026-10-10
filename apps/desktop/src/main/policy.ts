import { MAX_BADGE } from "../shared/notify";

/** The dock/taskbar count from the renderer: a whole number in range, or refused. */
export const normalizeBadge = (n: unknown): number | null => (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_BADGE ? n : null);

/** What the window is for the user right now: focused AND on screen (a hidden or minimized window is not read). */
export const windowIsFocused = (w: { isFocused(): boolean; isVisible(): boolean; isMinimized(): boolean }, override: boolean | null) =>
  override ?? (w.isFocused() && w.isVisible() && !w.isMinimized());

/** Closing the window hides it (to the tray / dock) when the user wants that, but a real quit always goes through. */
export const shouldHideOnClose = ({ closeToTray, quitting }: { closeToTray: boolean; quitting: boolean }) => closeToTray && !quitting;

/**
 * The login item to register, or null = leave it alone. Only the installed app ever registers: in development the
 * "app" is the generic Electron binary, which must never end up in the user's login items.
 */
export function loginItemSettings({ isPackaged, startAtLogin }: { isPackaged: boolean; startAtLogin: boolean }) {
  return isPackaged ? { openAtLogin: startAtLogin, args: [START_HIDDEN] } : null;
}
export const START_HIDDEN = "--hidden";

/** A launch by the OS at login (or with --hidden) goes straight to the tray without showing the window. */
export const startsHidden = ({ argv, wasOpenedAtLogin }: { argv: readonly string[]; wasOpenedAtLogin: boolean }) => wasOpenedAtLogin || argv.includes(START_HIDDEN);

export type TrayItem = { id: "open" | "notifications" | "quit"; label: string; checked?: boolean } | { id: "separator" };
/** The tray menu, as data (Electron builds the real one from it). */
export const trayMenuModel = ({ notifications }: { notifications: boolean }): TrayItem[] => [
  { id: "open", label: "Mở Loop" },
  { id: "notifications", label: "Thông báo", checked: notifications },
  { id: "separator" },
  { id: "quit", label: "Thoát" },
];

/** Clicking the tray icon: bring the window forward, or hide it when it is already the thing being looked at. */
export const trayClickAction = (w: { focused: boolean; visible: boolean }): "show" | "hide" => (w.visible && w.focused ? "hide" : "show");

type Revealable = { isMinimized(): boolean; restore(): void; show(): void; focus(): void };
/** Brings a (possibly hidden or minimized) window to the front: tray, second launch, notification click. */
export function revealWindow(w: Revealable) {
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}
