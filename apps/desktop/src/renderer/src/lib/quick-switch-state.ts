import { create } from "zustand";
import { shouldToggle } from "./quick-switch-keys";

/** Whether the palette is open, and which element had the focus before it opened (to give it back on close). */
export const useQuickSwitch = create<{ open: boolean }>(() => ({ open: false }));
let opener: HTMLElement | null = null;

export function toggleQuickSwitch() {
  const open = useQuickSwitch.getState().open;
  if (!shouldToggle(open, !!document.querySelector("dialog[open]"))) return;
  if (!open) opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  useQuickSwitch.setState({ open: !open });
}

export const closeQuickSwitch = () => useQuickSwitch.setState({ open: false });

/** After the dialog has closed (its background is inert before that): focus goes back to where it was. */
export function restoreFocus() {
  if (opener?.isConnected) opener.focus();
  opener = null;
}
