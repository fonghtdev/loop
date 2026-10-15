import { useMemo } from "react";
import { useStore } from "zustand";
import { presence } from "./app";
import { useBlocks } from "./queries";
import { shownStatus } from "./presence";

/** The status to show for anyone (offline when unknown, blocked, or before the block list is known). */
export function useStatusOf() {
  const byUser = useStore(presence.store, (s) => s.byUser);
  const blocks = useBlocks();
  const blocked = useMemo(() => (blocks.isSuccess ? new Set(blocks.data.map((u) => u.id)) : null), [blocks.isSuccess, blocks.data]);
  return (userId: string) => shownStatus(byUser, userId, blocked);
}
