import { useStore } from "zustand";
import { firstRun } from "./app";
import { progress } from "./firstrun";
import { useDms, useFriends, useGuilds } from "./queries";

/** The signed-in account's counts, steps and saved flags; null until the three lists have loaded (nothing flashes in). */
export function useFirstRun() {
  const guilds = useGuilds().data;
  const friends = useFriends().data;
  const dms = useDms().data;
  const saved = useStore(firstRun.store, (s) => s.saved);
  if (!guilds || !friends || !dms) return null;
  const counts = { servers: guilds.length, friends: friends.friends.length, dms: dms.length };
  return { counts, saved, done: progress(counts, saved) };
}
