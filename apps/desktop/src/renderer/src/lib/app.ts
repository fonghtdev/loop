import { QueryClient } from "@tanstack/react-query";
import { API_URL } from "../../../shared/config";
import { ApiError } from "./auth-client";
import { createChat } from "./chat";
import { goHome, useNav, writeLastPlace } from "./nav";
import { createRealtime } from "./realtime";
import { createSession } from "./session";

// The app's singletons. REST data goes through TanStack Query using `session.client.request`; messages live in `chat`.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // a 4xx will not change on retry (404 = not a member / no access any more); network and 5xx get one more try
      retry: (count, err) => count < 1 && !(err instanceof ApiError && err.status >= 400 && err.status < 500),
    },
  },
});

export const session = createSession({
  baseUrl: API_URL,
  storage: window.loop.session,
  onSignedOut: () => {
    realtime.stop();
    chat.reset();
    queryClient.clear();
    goHome();
  },
});

const myId = () => session.useSession.getState().user?.id;

export const chat = createChat({ request: session.client.request, myId });

/** Permissions or lists may have changed: refetch this guild's data (guild + channels, members, roles) and the server list. */
export function revalidateGuild(guildId: string | null) {
  void queryClient.invalidateQueries({ queryKey: ["guilds"] });
  if (guildId) void queryClient.invalidateQueries({ queryKey: ["guild", guildId] });
}

export const realtime = createRealtime({
  url: API_URL,
  getToken: (rejected) => session.client.accessToken(rejected),
  onEvent: (channelId, event) => chat.receive(channelId, event),
  onSubscribed: (channelId) => void chat.catchUp(channelId),
  onRefused: (channelId) => {
    chat.markUnavailable(channelId);
    revalidateGuild(useNav.getState().guildId);
  },
  onReconnected: () => void queryClient.invalidateQueries(),
});

// The socket lives exactly as long as the signed-in session.
session.useSession.subscribe((s, prev) => {
  if (s.status === "signedIn" && prev.status !== "signedIn") realtime.start();
  if (s.status !== "signedIn" && prev.status === "signedIn") realtime.stop();
});

useNav.subscribe((place) => {
  const id = myId();
  if (id) writeLastPlace(id, place);
});
