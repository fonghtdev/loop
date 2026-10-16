import { parseKey, type ConvKey } from "./conversation";
import type { Message } from "./chat";

export const pinsPath = (key: ConvKey) => {
  const { kind, id } = parseKey(key);
  return kind === "dm" ? `/dms/${id}/pins` : `/channels/${id}/pins`;
};

/**
 * Who may pin / unpin, from what the UI already knows (only to show or hide the buttons; the server decides). A
 * channel needs MANAGE_MESSAGES for both. In a DM either person pins while the friendship stands (`canWrite`), and may
 * always take a pin back.
 */
export function pinRights(key: ConvKey, { canManage, canWrite }: { canManage: boolean; canWrite: boolean }) {
  return parseKey(key).kind === "dm" ? { pin: canWrite, unpin: true } : { pin: canManage, unpin: canManage };
}

export type PinRow = { message: Message; /** The message is in the loaded history, so the list can scroll to it. */ loaded: boolean };

/**
 * The panel's rows: the server's list (newest pin first), each message replaced by the copy the open conversation
 * holds when it has one (edits and reactions stay current), and dropped when that copy says it was unpinned meanwhile.
 */
export function pinRows(fetched: Message[], live: Message[]): PinRow[] {
  const held = new Map(live.map((m) => [m.id, m]));
  return fetched.flatMap((m) => {
    const copy = held.get(m.id);
    return copy?.pinned === false ? [] : [{ message: copy ?? m, loaded: !!copy }];
  });
}
