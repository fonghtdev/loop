import { useCallback } from "react";
import { useStore } from "zustand";
import { displayNameOf } from "./identity";
import { profiles } from "./profiles";
import { useDms, useMembers } from "./queries";
import { dmPeople } from "./social";
import { session } from "./app";

/**
 * userId -> the name to show for a mention, from what the screen already holds: the open server's members, or the
 * DM list and ourselves at Home. undefined when nobody told us (the chip then says "unknown").
 */
export function useMentionName(guildId: string | null) {
  const byId = useStore(profiles.store, (s) => s.byId);
  const members = useMembers(guildId).data;
  const dms = useDms().data;
  const me = session.useSession((s) => s.user);
  return useCallback(
    (id: string) => {
      const username = members?.find((m) => m.userId === id)?.username ?? dms?.flatMap(dmPeople).find((u) => u.id === id)?.username ?? (me?.id === id ? me.username : undefined);
      return username === undefined ? byId[id]?.displayName || undefined : displayNameOf(byId, id, username);
    },
    [byId, members, dms, me],
  );
}
