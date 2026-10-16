import { useMemo } from "react";
import { useStore } from "zustand";
import { presence, session } from "./app";
import { useBlocks } from "./queries";
import { statusShownFor } from "./presence";

/** The status to show for anyone (offline when unknown, blocked, or before the block list is known); for ourselves, our own choice (invisible = offline). */
export function useStatusOf() {
  const byUser = useStore(presence.store, (s) => s.byUser);
  const mine = useStore(presence.store, (s) => s.mine);
  const selfId = session.useSession((s) => s.user?.id);
  const blocks = useBlocks();
  const blocked = useMemo(() => (blocks.isSuccess ? new Set(blocks.data.map((u) => u.id)) : null), [blocks.isSuccess, blocks.data]);
  return (userId: string) => statusShownFor(byUser, userId, blocked, { id: selfId, pref: mine });
}
