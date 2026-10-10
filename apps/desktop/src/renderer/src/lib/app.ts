import { QueryClient } from "@tanstack/react-query";
import { Room } from "livekit-client";
import { API_URL, LIVEKIT_ORIGIN } from "../../../shared/config";
import { createAdminApi } from "./admin-api";
import { ApiError } from "./auth-client";
import { createAudioSink } from "./audio-sink";
import { createCalls } from "./calls";
import { createChat } from "./chat";
import { goHome, useNav, writeLastPlace } from "./nav";
import type { Guild } from "./permissions";
import { createRealtime } from "./realtime";
import { createSession } from "./session";
import { createUploader } from "./upload-client";
import { createVoice, type RoomLike } from "./voice";
import { createVoicePresence } from "./voice-presence";
import { applySocialEvent, FRIENDS_KEY } from "./social";

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
    voice.leave();
    calls.reset();
    voicePresence.clear();
    realtime.stop();
    chat.reset();
    queryClient.clear();
    goHome();
  },
});

const myId = () => session.useSession.getState().user?.id;

export const uploadAttachment = createUploader({ request: session.client.request });

export const chat = createChat({
  request: session.client.request,
  myId,
  // a refused DM send means the friends list is stale
  onForbidden: () => void queryClient.invalidateQueries({ queryKey: FRIENDS_KEY }),
});

/** Permissions or lists may have changed: refetch this guild's data (guild + channels, members, roles) and the server list. */
export function revalidateGuild(guildId: string | null) {
  void queryClient.invalidateQueries({ queryKey: ["guilds"] });
  if (guildId) void queryClient.invalidateQueries({ queryKey: ["guild", guildId] });
}

/** Server administration calls (9e); each refetches the guild's data afterwards. */
export const admin = createAdminApi({
  request: session.client.request,
  changed: (guildId) => Promise.all([queryClient.invalidateQueries({ queryKey: ["guilds"] }), queryClient.invalidateQueries({ queryKey: ["guild", guildId] })]),
  gone: (guildId) => {
    queryClient.setQueryData<Guild[]>(["guilds"], (old) => old?.filter((g) => g.id !== guildId));
    queryClient.removeQueries({ queryKey: ["guild", guildId] });
    goHome();
  },
});

/** Who is in each visible voice channel (pushes + REST catch-up); the live room takes over for the one we are in. */
export const voicePresence = createVoicePresence();

/** The one voice session. A real livekit Room is only ever created here. */
export const voice = createVoice({
  request: session.client.request,
  // the room adapts quality to what is on screen and stops sending layers nobody watches (CPU/bandwidth)
  createRoom: () => new Room({ adaptiveStream: true, dynacast: true }) as unknown as RoomLike,
  sink: createAudioSink(),
  ensureMedia: (kind) => window.loop.media.ensureAccess(kind).catch(() => false),
  livekitOrigin: LIVEKIT_ORIGIN,
});
export const calls = createCalls({ voice, request: session.client.request });
// leave the room when the window goes away (the server also notices, but a clean leave frees the seat at once)
addEventListener("pagehide", () => voice.leave());

async function fetchVoiceSeats(channelId: string) {
  const begun = voicePresence.begin(channelId);
  try {
    const r = await session.client.request<{ participants: { userId: string; username: string }[] }>("GET", `/channels/${channelId}/voice`);
    voicePresence.applyFetched(channelId, begun, r.participants);
  } catch {
    // the next push or reconnect brings the list; a hidden channel is revalidated through the guild data
  }
}

export const realtime = createRealtime({
  url: API_URL,
  getToken: (rejected) => session.client.accessToken(rejected),
  onEvent: (key, event) => chat.receive(key, event),
  onSubscribed: (key) => void chat.catchUp(key),
  onRefused: (key) => {
    chat.markUnavailable(key);
    revalidateGuild(useNav.getState().guildId);
  },
  onSocial: (event) => applySocialEvent(queryClient, event),
  onWatched: (channelId) => void fetchVoiceSeats(channelId),
  onWatchRefused: () => revalidateGuild(useNav.getState().guildId),
  onVoiceUpdate: (channelId, seats) => voicePresence.update(channelId, seats),
  onCall: (event) => calls.handle(event),
  // everything may have changed meanwhile: friends, DM list, blocks, permissions (the open conversation catches up separately)
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
