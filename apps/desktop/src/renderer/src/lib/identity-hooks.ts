import { useStore } from "zustand";
import { profiles } from "./profiles";
import { displayNameOf } from "./identity";

/** The name to show for one user (re-renders only when that name changes). */
export const useDisplayName = (id: string, username: string) => useStore(profiles.store, (s) => displayNameOf(s.byId, id, username));

/** `displayNameOf` over the live store, for lists and for text built from several names. */
export function useNameOf() {
  const byId = useStore(profiles.store, (s) => s.byId);
  return (id: string, username: string) => displayNameOf(byId, id, username);
}
