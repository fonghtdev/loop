import { isNotifyKey, navigateKey, type NotifyKind, type NotifyPayload } from "../shared/notify";
import type { Settings } from "../shared/settings";

export const TITLE_MAX = 80;
export const BODY_MAX = 200;
/** What a notification says when message previews are off. (Strings of the main process live here; the renderer sends the rest.) */
export const GENERIC_BODY = "Tin nhắn mới";

const KINDS: NotifyKind[] = ["message", "call", "video-call"];
// control characters and bidi overrides become spaces: a notification is plain text, never layout
const CLEAN = /[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g;
const plain = (s: string) => s.replace(CLEAN, " ").trim();

/** A notify request from the renderer, checked field by field; null = refuse. Text is never interpreted as markup. */
export function parseNotify(raw: unknown): NotifyPayload | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { conversationKey, title, body, kind } = raw as Record<string, unknown>;
  if (!KINDS.includes(kind as NotifyKind) || !isNotifyKey(conversationKey)) return null;
  if ((kind === "message") === conversationKey.startsWith("call:")) return null; // a call has a call key, a message a conversation key
  if (typeof title !== "string" || typeof body !== "string" || title.length > TITLE_MAX || body.length > BODY_MAX) return null;
  const cleanTitle = plain(title);
  return cleanTitle ? { conversationKey, title: cleanTitle, body: plain(body), kind: kind as NotifyKind } : null;
}

/** What the OS shows, or null when notifications are off. Preview off hides the text of messages (calls say nothing private). */
export function presentable(p: NotifyPayload, s: Pick<Settings, "notifications" | "preview">): { title: string; body: string } | null {
  if (!s.notifications) return null;
  return { title: p.title, body: p.kind === "message" && !s.preview ? GENERIC_BODY : p.body };
}

type NotificationLike = { show(): void; close(): void; on(event: "click" | "close", fn: () => void): unknown };
type Deps = {
  Notification: { new (o: { title: string; body: string; silent: boolean }): NotificationLike; isSupported(): boolean };
  settings: () => Pick<Settings, "notifications" | "preview">;
  /** A notification was clicked: bring the window forward and tell the renderer where to go (a validated conversation key). */
  onClick: (navigateTo: string) => void;
  /** Tests only: do not show anything, keep a log instead. */
  record?: { log: { key: string; title: string; body: string; kind: NotifyKind; closed: boolean }[]; click: Map<string, () => void> };
};

/** One live notification per key: a newer one for the same conversation replaces the older; a call's is closed by its key. */
export function createNotifier({ Notification, settings, onClick, record }: Deps) {
  const live = new Map<string, NotificationLike>();
  const close = (key: string) => {
    live.get(key)?.close();
    live.delete(key);
    if (record) for (const e of record.log) if (e.key === key) e.closed = true;
  };
  return {
    show(raw: unknown) {
      const p = parseNotify(raw);
      if (!p) throw new Error("invalid notification");
      const shown = presentable(p, settings());
      if (!shown || !Notification.isSupported()) return;
      close(p.conversationKey);
      const n = new Notification({ ...shown, silent: false });
      const key = p.conversationKey;
      const click = () => onClick(navigateKey(key));
      n.on("click", click);
      n.on("close", () => live.get(key) === n && live.delete(key));
      live.set(key, n);
      if (record) {
        record.log.push({ key, ...shown, kind: p.kind, closed: false });
        record.click.set(key, click);
        return;
      }
      n.show();
    },
    close(key: unknown) {
      if (!isNotifyKey(key)) throw new Error("invalid notification key");
      close(key);
    },
  };
}
