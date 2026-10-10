import { create } from "zustand";
import { createAuthClient, type User } from "./auth-client";

type Deps = Omit<Parameters<typeof createAuthClient>[0], "onSignedOut"> & { onSignedOut?: () => void };
export type SessionState = {
  /** restoring: splash; offline: stored session but no server; signedOut: auth screen; signedIn: shell */
  status: "restoring" | "offline" | "signedOut" | "signedIn";
  user: User | null;
  /** false when the refresh token cannot be stored encrypted (session ends when the app quits) */
  persistent: boolean;
};

/** Auth state (Zustand) wired to the auth client: the screens only read `status` and call these actions. */
export function createSession(deps: Deps) {
  const useSession = create<SessionState>(() => ({ status: "restoring", user: null, persistent: true }));
  const client = createAuthClient({
    ...deps,
    onSignedOut: () => {
      useSession.setState({ status: "signedOut", user: null });
      deps.onSignedOut?.();
    },
  });
  const signedIn = (user: User) => useSession.setState({ status: "signedIn", user });

  return {
    useSession,
    client,
    async start() {
      useSession.setState({ status: "restoring" });
      useSession.setState({ persistent: (await deps.storage.get()).persistent });
      try {
        const user = await client.restore();
        if (user) signedIn(user);
        else useSession.setState({ status: "signedOut", user: null });
      } catch {
        useSession.setState({ status: "offline" });
      }
    },
    login: async (body: { email: string; password: string }) => signedIn(await client.login(body)),
    register: async (body: { email: string; username: string; password: string }) => signedIn(await client.register(body)),
    logout: () => client.logout(),
  };
}
