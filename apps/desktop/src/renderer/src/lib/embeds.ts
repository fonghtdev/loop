import { useSyncExternalStore } from "react";
import type { MessageEmbed } from "@loop/shared";
import { API_URL } from "../../../shared/config";
import { isSafeExternalUrl } from "../../../shared/url";

/** One link preview as the message row draws it. `thumbnail` is a full URL on the API (302 to storage), or null. */
export type EmbedCard = { key: string; url: string; siteName: string; title: string | null; description: string | null; thumbnail: string | null };

// The only shape of thumbnail path the server hands out; anything else is not loaded (the CSP would refuse it anyway).
const THUMBNAIL = /^\/embeds\/[0-9a-f-]{36}\/thumbnail$/;

export const embedKey = (messageId: string, url: string) => `${messageId} ${url}`;

/** "www.example.com/a" -> "example.com"; "" when it is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The cards of one message: none when previews are off; a card closed here stays closed (for this run). */
export function embedCards(messageId: string, embeds: MessageEmbed[] | undefined, { enabled, hidden }: { enabled: boolean; hidden: ReadonlySet<string> }): EmbedCard[] {
  if (!enabled || !embeds?.length) return [];
  return embeds.flatMap((e) => {
    const key = embedKey(messageId, e.url);
    if (hidden.has(key) || !isSafeExternalUrl(e.url) || (!e.title && !e.description)) return [];
    const thumbnail = e.thumbnail && THUMBNAIL.test(e.thumbnail) ? `${API_URL}${e.thumbnail}` : null;
    return [{ key, url: e.url, siteName: e.siteName || hostOf(e.url), title: e.title, description: e.description, thumbnail }];
  });
}

type Store = Pick<Storage, "getItem" | "setItem">;
const PREF_KEY = "loop.linkPreviews";

/** An on/off choice per device (localStorage, like the appearance choices). Any storage failure means the default (on). */
export function createFlagPref(key: string, storage: () => Store | undefined) {
  const listeners = new Set<() => void>();
  let on = true;
  try {
    on = storage()?.getItem(key) !== "off";
  } catch {
    // blocked storage: default
  }
  return {
    get: () => on,
    set(next: boolean) {
      on = next;
      try {
        storage()?.setItem(key, next ? "on" : "off");
      } catch {
        // the choice still holds for this run
      }
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

/** "Show link previews". Only hides them here: the server still fetches. */
export const createLinkPreviewPref = (storage: () => Store | undefined) => createFlagPref(PREF_KEY, storage);

/** Cards closed with their "x": local to this device and this run (ponytail: not persisted; the server never knows). */
export function createEmbedHides() {
  const listeners = new Set<() => void>();
  let hidden: ReadonlySet<string> = new Set();
  return {
    get: () => hidden,
    hide(key: string) {
      hidden = new Set([...hidden, key]);
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export const linkPreviews = createLinkPreviewPref(() => globalThis.window?.localStorage);
export const embedHides = createEmbedHides();
export const useLinkPreviews = () => useSyncExternalStore(linkPreviews.subscribe, linkPreviews.get);
export const useHiddenEmbeds = () => useSyncExternalStore(embedHides.subscribe, embedHides.get);
