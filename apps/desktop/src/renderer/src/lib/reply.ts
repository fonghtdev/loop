import type { Message } from "./chat";

/** The message the composer is answering, or null once it is no longer in the list (deleted meanwhile). */
export const liveReplyTarget = (target: Message | null, messages: Message[]) => (target && messages.some((m) => m.id === target.id) ? target : null);

/** Esc in the composer drops the reply, but the Esc that closes an IME composition must not. */
export const cancelsReply = (e: { key: string; isComposing?: boolean }, replying: boolean) => replying && e.key === "Escape" && !e.isComposing;

const FLASH_MS = 1600;

/** Scrolls to a loaded message and highlights it briefly. false = it is not in the list (nothing happens). */
export function jumpToMessage(list: HTMLElement, id: string, smooth: boolean): boolean {
  const row = list.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
  if (!row) return false;
  row.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  row.dataset.flash = "";
  setTimeout(() => row.removeAttribute("data-flash"), FLASH_MS);
  return true;
}
