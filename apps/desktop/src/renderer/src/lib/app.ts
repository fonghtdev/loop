import { QueryClient } from "@tanstack/react-query";
import { Room } from "livekit-client";
import { API_URL, LIVEKIT_ORIGIN } from "../../../shared/config";
import { createAdminApi } from "./admin-api";
import { ApiError } from "./auth-client";
import { createAppSettings } from "./app-settings";
import { createAudioSink } from "./audio-sink";
import { createCalls } from "./calls";
import { createDevices } from "./devices";
import { createChat, type Message } from "./chat";
import { goHome, openConversation, placeForKey, useNav, writeLastPlace } from "./nav";
import type { Guild } from "./permissions";
import { createRealtime } from "./realtime";
import { createSession } from "./session";
import { createFirstRun } from "./firstrun";
import { createUnread, titleWith, total } from "./unread";
import { windowFocus } from "./window-focus";
import { createUploader } from "./upload-client";
import { createVoice, type RoomLike } from "./voice";
import { createVoicePresence } from "./voice-presence";
import { dmKey, type ConvKey } from "./conversation";
import { callNotice, messageNotice, shouldNotify } from "./notify";
import { applyGuildEvent } from "./categories";
import { applySocialEvent, BLOCKS_KEY, DMS_KEY, FRIENDS_KEY, type Dm, type PublicUser } from "./social";

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
    unread.reset();
    realtime.stop();
    chat.reset();
    queryClient.clear();
    goHome();
  },
});

const myId = () => session.useSession.getState().user?.id;

export const uploadAttachment = createUploader({ request: session.client.request });

/** Unread marks: persisted per user in localStorage (non-sensitive), the counts live for the session. */
export const unread = createUnread({
  storage: {
    read: (userId) => localStorage.getItem(`loop.lastSeen.${userId}`),
    write: (userId, value) => localStorage.setItem(`loop.lastSeen.${userId}`, value),
  },
});
unread.setFocused(windowFocus.getState().focused);
windowFocus.subscribe((s) => unread.setFocused(s.focused));
// the unread total is the window title prefix and the dock badge
let shownTotal = 0;
unread.store.subscribe((s) => {
  const n = total(s);
  if (n === shownTotal) return;
  shownTotal = n;
  document.title = titleWith(n);
  void window.loop.setBadge(n).catch(() => undefined);
});

/** The "Bắt đầu" checklist's saved part (events that leave no trace in the data), per account in localStorage. */
export const firstRun = createFirstRun(() => localStorage);

/** The main process's settings (notifications, tray, login item). */
export const appSettings = createAppSettings(window.loop.settings);

export const chat = createChat({
  request: session.client.request,
  myId,
  onMissed: (key, missed) => missed.forEach((m) => unread.message(key, m, m.author.id, myId())),
  // a refused DM send means the friends list is stale
  onForbidden: () => void queryClient.invalidateQueries({ queryKey: FRIENDS_KEY }),
  onSent: () => void firstRun.record("message"),
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

const sink = createAudioSink();

/** The one voice session. A real livekit Room is only ever created here. */
export const voice = createVoice({
  request: session.client.request,
  // the room adapts quality to what is on screen and stops sending layers nobody watches (CPU/bandwidth);
  // it starts on the microphone / camera chosen in settings (undefined = the system default)
  createRoom: () =>
    new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { deviceId: devices.effective("audioinput") },
      videoCaptureDefaults: { deviceId: devices.effective("videoinput") },
    }) as unknown as RoomLike,
  sink,
  ensureMedia: (kind) => window.loop.media.ensureAccess(kind).catch(() => false),
  livekitOrigin: LIVEKIT_ORIGIN,
});

/** Microphone / speaker / camera choices (settings), applied to the live session and to every new one. */
export const devices = createDevices({
  storage: { read: () => localStorage.getItem("loop.devices"), write: (v) => localStorage.setItem("loop.devices", v) },
  enumerate: async () => (await navigator.mediaDevices.enumerateDevices()).map(({ kind, deviceId, label }) => ({ kind, deviceId, label })),
  apply: (kind, id) => (kind === "audiooutput" ? sink.setOutput(id ?? null) : void voice.switchDevice(kind, id ?? "default")),
});
navigator.mediaDevices?.addEventListener("devicechange", () => void devices.refresh());
void devices.refresh();
// joining voice has just been granted microphone access: labels and ids are visible now
voice.store.subscribe((s, prev) => s.status === "connected" && prev.status !== "connected" && void devices.refresh());
// the first time in voice (a channel or a call) ticks a checklist step
voice.store.subscribe((s, prev) => s.status === "connected" && prev.status !== "connected" && void firstRun.record("voice"));

/** Asks for microphone access (macOS prompts through the main process) so the device names become readable. */
export async function unlockDeviceLabels() {
  if (!(await window.loop.media.ensureAccess("microphone").catch(() => false))) return false;
  try {
    (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((track) => track.stop());
  } catch {
    return false;
  }
  await devices.refresh();
  return true;
}
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

// ---- OS notifications: the renderer decides (shouldNotify), the main process shows ----
const isBlocked = (userId: string) => !!queryClient.getQueryData<PublicUser[]>(BLOCKS_KEY)?.some((u) => u.id === userId);
const ask = (fn: () => Promise<void>) => void fn().catch(() => undefined); // a notification that cannot be shown is not an error

function notifyMessage(key: ConvKey, m: Message) {
  const wanted = shouldNotify({
    kind: "message",
    isOwn: m.author.id === myId(),
    windowFocused: windowFocus.getState().focused,
    openConversation: openConversation(useNav.getState()),
    conversation: key,
    blocked: isBlocked(m.author.id),
    settings: appSettings.store.getState().settings,
  });
  if (wanted && m.dmChannelId) ask(() => window.loop.notify(messageNotice(m)));
}

// a ringing call notifies; it is closed when the ring ends for any reason (answered, declined, ended, signed out)
calls.store.subscribe((s, prev) => {
  if (prev.incoming && prev.incoming.dmId !== s.incoming?.dmId) ask(() => window.loop.closeNotification(`call:${prev.incoming!.dmId}`));
  const call = s.incoming;
  if (!call || call.dmId === prev.incoming?.dmId) return;
  const wanted = shouldNotify({
    kind: "call",
    isOwn: false,
    windowFocused: windowFocus.getState().focused,
    openConversation: openConversation(useNav.getState()),
    conversation: dmKey(call.dmId),
    blocked: isBlocked(call.from.id),
    settings: appSettings.store.getState().settings,
  });
  if (wanted) ask(() => window.loop.notify(callNotice(call.dmId, call.from.username, call.video)));
});

// a clicked notification: go there, but only if the place is still valid
window.loop.onNavigate((key) => {
  if (session.useSession.getState().status !== "signedIn") return;
  const place = placeForKey(key as ConvKey, queryClient.getQueryData<Dm[]>(DMS_KEY)?.map((d) => d.id));
  if (place) useNav.setState(place);
});

export const realtime = createRealtime({
  url: API_URL,
  getToken: (rejected) => session.client.accessToken(rejected),
  onEvent: (key, event) => chat.receive(key, event),
  onActivity: (key, event) => {
    if (event.type === "message:delete") return unread.deleted(key, event.id);
    if (event.type !== "message:new") return;
    unread.message(key, event.message, event.message.author.id, myId());
    notifyMessage(key, event.message);
  },
  onSubscribed: (key) => void chat.catchUp(key),
  onRefused: (key) => {
    chat.markUnavailable(key);
    revalidateGuild(useNav.getState().guildId);
  },
  onSocial: (event) => applySocialEvent(queryClient, event),
  onGuild: (event) => applyGuildEvent(queryClient, event),
  onWatched: (channelId) => void fetchVoiceSeats(channelId),
  onWatchRefused: () => revalidateGuild(useNav.getState().guildId),
  onVoiceUpdate: (channelId, seats) => voicePresence.update(channelId, seats),
  onCall: (event) => calls.handle(event),
  // everything may have changed meanwhile: friends, DM list, blocks, permissions (the open conversation catches up separately)
  onReconnected: () => void queryClient.invalidateQueries(),
});

// The socket lives exactly as long as the signed-in session.
session.useSession.subscribe((s, prev) => {
  if (s.status === "signedIn" && prev.status !== "signedIn") {
    if (s.user) {
      unread.start(s.user.id);
      firstRun.start(s.user.id);
    }
    void appSettings.load();
    realtime.start();
  }
  if (s.status !== "signedIn" && prev.status === "signedIn") {
    realtime.stop();
    firstRun.stop();
  }
});

useNav.subscribe((place) => {
  const id = myId();
  if (id) writeLastPlace(id, place);
});
