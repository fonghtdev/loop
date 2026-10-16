import { QueryClient } from "@tanstack/react-query";
import { Room } from "livekit-client";
import { API_URL, LIVEKIT_ORIGIN } from "../../../shared/config";
import { createAdminApi } from "./admin-api";
import { createImageUploader } from "./image-upload";
import { createProfileApi, profileKey } from "./profile-api";
import { ApiError } from "./auth-client";
import { createAppSettings } from "./app-settings";
import { createAudioSink } from "./audio-sink";
import { createCalls } from "./calls";
import { t } from "../i18n/t";
import { createDevices, optionsFor } from "./devices";
import { captureShare, createGoLivePrefs } from "./golive";
import { createChat, type Message } from "./chat";
import { goHome, openConversation, placeForKey, useNav, writeLastPlace } from "./nav";
import type { Guild, Member } from "./permissions";
import { applyGuildUpdated, displayNameOf } from "./identity";
import { profiles } from "./profiles";
import { createPresence } from "./presence";
import { createRealtime } from "./realtime";
import { createSession } from "./session";
import { createFirstRun } from "./firstrun";
import { createUnread, titleWith, total } from "./unread";
import { createUnreadSync } from "./unread-sync";
import { createTyping, createTypingSender } from "./typing";
import { pendingJump } from "./search";
import { windowFocus } from "./window-focus";
import { createUploader } from "./upload-client";
import { soundPrefs } from "./sound-prefs";
import { createShortcutHandler } from "./shortcut-handler";
import { createSounds, createTonePlayer, type SoundKind } from "./sounds";
import { createNoiseLevel, noiseConfig } from "./noise";
import { buildGraph } from "./noise-graph";
import { createNoiseProcessor } from "./noise-processor";
import { createScreenPicker } from "./screen-picker";
import { tapAudio } from "./speech-level";
import { createVoice, type RoomLike } from "./voice";
import { createVoicePresence } from "./voice-presence";
import { channelKey, dmKey, parseKey, type ConvKey } from "./conversation";
import { mentionsMe } from "./mentions";
import { callNotice, messageNotice, shouldNotify } from "./notify";
import { applyGuildEvent, type GuildData } from "./categories";
import { toast } from "./toast";
import { moderationNotices } from "./voice-mod";
import { createVoiceMoved } from "./voice-moved";
import { applySocialEvent, BLOCKS_KEY, DMS_KEY, FRIENDS_KEY, isGroup, type Dm, type PublicUser } from "./social";
import { applyThreadEvent, createThreadPanel, parentOf, starterUpdate, threadsKey, threadsPath, type Thread, type ThreadEvent } from "./threads";

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

/** The thread open in the side panel next to its channel (lib/threads). */
export const threadPanel = createThreadPanel();

export const session = createSession({
  baseUrl: API_URL,
  storage: window.loop.session,
  onSignedOut: () => {
    voice.leave();
    calls.reset();
    voicePresence.clear();
    presence.clear();
    profiles.clear();
    unread.reset();
    unreadSync.cancel();
    typing.reset();
    typingSender.reset();
    pendingJump.clear();
    threadPanel.close();
    realtime.stop();
    chat.reset();
    queryClient.clear();
    goHome();
  },
});

/** Everyone's status plus the user's own choice (lib/presence). */
export const presence = createPresence({ request: session.client.request });

export const uploadImage = createImageUploader({ request: session.client.request });

/** A user's public fields changed (their own edit or a `user:updated`): the store follows and a cached profile card refetches. */
function userChanged(e: Parameters<typeof profiles.apply>[0] & { id: string }) {
  profiles.apply(e);
  void queryClient.invalidateQueries({ queryKey: profileKey(e.id) });
}

/** The signed-in user's own profile calls (settings). */
export const profileApi = createProfileApi({ request: session.client.request, upload: uploadImage, changed: userChanged });

const myId = () => session.useSession.getState().user?.id;

export const uploadAttachment = createUploader({ request: session.client.request });

/** Unread counts: the server keeps the read pointers (lib/unread-sync), the counts live for the session. */
export const unread = createUnread({ report: (key, seq) => unreadSync.mark(key, seq) });
export const unreadSync = createUnreadSync({ request: session.client.request, apply: unread.seed });
unread.setFocused(windowFocus.getState().focused);
/** Coming back to the window re-reads the counts of servers that are not open (their messages are not pushed), at most this often. */
const FOCUS_REFRESH_MS = 30_000;
windowFocus.subscribe((s) => {
  unread.setFocused(s.focused);
  if (s.focused) unreadSync.refresh(FOCUS_REFRESH_MS);
});

/** Who is typing where, and when our own typing is announced (lib/typing). */
export const typing = createTyping();
export const typingSender = createTypingSender({ send: (key) => realtime.sendTyping(key) });
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
  // the server counted what was missed; asked for after the catch-up so the two never add up
  onMissed: () => unreadSync.refresh(),
  // a refused DM send means the friends list is stale
  onForbidden: () => void queryClient.invalidateQueries({ queryKey: FRIENDS_KEY }),
  onSent: () => void firstRun.record("message"),
  onAuthors: (authors) => profiles.seed(authors, null),
});

/** Permissions or lists may have changed: refetch this guild's data (guild + channels, members, roles) and the server list. */
export function revalidateGuild(guildId: string | null) {
  void queryClient.invalidateQueries({ queryKey: ["guilds"] });
  if (guildId) void queryClient.invalidateQueries({ queryKey: ["guild", guildId] });
}

/** Server administration calls (9e); each refetches the guild's data afterwards. */
export const admin = createAdminApi({
  request: session.client.request,
  upload: uploadImage,
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

// e2e only (the preload flag is false in a real build): a counter per sound kind the test can read
const soundCounts: Record<string, number> = {};
if (window.loop.e2e) (window as unknown as { __loopSounds: Record<string, number> }).__loopSounds = soundCounts;
const tonePlayer = createTonePlayer();
/** Join/leave sounds of the voice session (lib/sounds); settings per account in lib/sound-prefs. */
export const sounds = createSounds({
  player: tonePlayer,
  prefs: soundPrefs.get,
  onPlay: window.loop.e2e ? (kind: SoundKind) => void (soundCounts[kind] = (soundCounts[kind] ?? 0) + 1) : undefined,
});

/** The last Go Live quality and sound choices (the dialog starts from them). */
export const goLivePrefs = createGoLivePrefs({ storage: { read: () => localStorage.getItem("loop.golive"), write: (v) => localStorage.setItem("loop.golive", v) } });

/** The Go Live dialog: which screen, window or camera to share, at what quality (rendered by components/ScreenPicker). */
export const screenPicker = createScreenPicker({
  list: () => window.loop.screen.sources(),
  devices: async () => {
    await devices.refresh();
    return optionsFor(devices.store.getState().devices, "videoinput", t("golive.deviceFallback"));
  },
  save: goLivePrefs.set,
});

/** How hard the microphone is cleaned (settings); a live session follows at once. */
export const noiseLevel = createNoiseLevel({
  storage: { read: () => localStorage.getItem("loop.noise"), write: (v) => localStorage.setItem("loop.noise", v) },
  onChange: () => void voice.applyNoise(),
});

/** The one voice session. A real livekit Room is only ever created here. */
export const voice = createVoice({
  request: session.client.request,
  // the room adapts quality to what is on screen and stops sending layers nobody watches (CPU/bandwidth);
  // it starts on the microphone / camera chosen in settings (undefined = the system default)
  createRoom: () =>
    new Room({
      adaptiveStream: true,
      dynacast: true,
      // voice is always sent as stereo (a mono mic goes out as two equal channels), whatever the noise level
      audioCaptureDefaults: { deviceId: devices.effective("audioinput"), channelCount: 2 },
      publishDefaults: { forceStereo: true },
      videoCaptureDefaults: { deviceId: devices.effective("videoinput") },
    }) as unknown as RoomLike,
  sink,
  ensureMedia: (kind) => window.loop.media.ensureAccess(kind).catch(() => false),
  pickScreen: () => screenPicker.pick(),
  rememberShare: goLivePrefs.set,
  capture: (choice, profile) => captureShare(navigator.mediaDevices, window.loop.screen.choose, choice, profile),
  noise: {
    level: noiseLevel.get,
    processor: (level, onFail) => {
      const config = noiseConfig(level);
      return config.rnnoise ? createNoiseProcessor(config, onFail, buildGraph) : null;
    },
  },
  tap: tapAudio,
  livekitOrigin: LIVEKIT_ORIGIN,
  onSound: sounds.handle,
});
// the global mic / deafen shortcuts (main process) act on the live session
window.loop.onShortcut(createShortcutHandler(voice));
// a dialog left open by a session that is gone would only be answered into nothing
voice.store.subscribe((s) => s.status === "idle" && screenPicker.cancel());
// joining is a click: the audio context is created / resumed right then (the autoplay policy of the window already allows it)
voice.store.subscribe((s, prev) => s.status === "requestingToken" && prev.status !== "requestingToken" && sounds.unlock());

/** Microphone / speaker / camera choices (settings), applied to the live session and to every new one. */
export const devices = createDevices({
  storage: { read: () => localStorage.getItem("loop.devices"), write: (v) => localStorage.setItem("loop.devices", v) },
  enumerate: async () => (await navigator.mediaDevices.enumerateDevices()).map(({ kind, deviceId, label }) => ({ kind, deviceId, label })),
  apply: (kind, id) => (kind === "audiooutput" ? (sink.setOutput(id ?? null), tonePlayer.setOutput(id ?? null)) : void voice.switchDevice(kind, id ?? "default")),
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
export const calls = createCalls({
  voice,
  request: session.client.request,
  isGroup: (dmId) => !!queryClient.getQueryData<Dm[]>(DMS_KEY)?.some((d) => d.id === dmId && isGroup(d)),
});
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

// Leaving a room hands the seat list back to the pushed one, which was not updated while the live room was shown (and
// a missed webhook would leave it stale): ask the server who is still there.
voice.store.subscribe((s, prev) => {
  if (prev.target?.kind === "channel" && prev.status !== "idle" && prev.status !== "disconnected" && s.target?.id !== prev.target.id) void fetchVoiceSeats(prev.target.id);
});

/**
 * A message that names me, with the server it was said in. An open channel's server is the one on screen; a mention
 * pushed to the user's room (`mention:new`) says its server itself.
 */
function mentionInfo(key: ConvKey, m: Message, guildId?: string) {
  if (!mentionsMe(m, myId())) return undefined;
  return { guildId: guildId ?? (parseKey(key).kind === "channel" ? useNav.getState().guildId : null) };
}

/** The server a channel's mention came from, so a clicked notification can open it (only channels that mentioned us). */
const mentionGuilds = new Map<string, string>();
/** A thread that mentioned us -> its parent channel: a clicked notification opens the parent with the thread beside it. */
const threadParents = new Map<string, string>();

/** A name for a user id from what the app holds (profile name, else the username in any loaded member list). */
function knownName(id: string) {
  for (const [, data] of queryClient.getQueriesData<unknown>({ queryKey: ["guild"] })) {
    const member = Array.isArray(data) ? (data as Member[]).find((m) => m?.userId === id) : undefined;
    if (member) return displayNameOf(profiles.store.getState().byId, id, member.username);
  }
  return profiles.store.getState().byId[id]?.displayName || undefined;
}

// ---- OS notifications: the renderer decides (shouldNotify), the main process shows ----
const isBlocked = (userId: string) => !!queryClient.getQueryData<PublicUser[]>(BLOCKS_KEY)?.some((u) => u.id === userId);
const ask = (fn: () => Promise<void>) => void fn().catch(() => undefined); // a notification that cannot be shown is not an error

/** The thread in the side panel counts as on screen too. */
const sideKey = () => {
  const open = threadPanel.store.getState().thread;
  return open ? channelKey(open.id) : null;
};

const notified = new Set<string>(); // a mention in the open channel arrives twice (room and user room): one notification
function notifyMessage(key: ConvKey, m: Message) {
  if (notified.has(m.id)) return;
  const wanted = shouldNotify({
    kind: "message",
    isOwn: m.author.id === myId(),
    windowFocused: windowFocus.getState().focused,
    openConversation: sideKey() === key ? key : openConversation(useNav.getState()),
    conversation: key,
    blocked: isBlocked(m.author.id),
    settings: appSettings.store.getState().settings,
    myStatus: presence.store.getState().mine,
    mentioned: mentionsMe(m, myId()),
  });
  if (!wanted) return;
  if (notified.size > 200) notified.clear();
  notified.add(m.id);
  ask(() => window.loop.notify(messageNotice(m, knownName)));
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
    myStatus: presence.store.getState().mine,
    mentioned: false,
  });
  if (wanted) ask(() => window.loop.notify(callNotice(call.dmId, call.from.username, call.video)));
});

// a clicked notification: go there, but only if the place is still valid
window.loop.onNavigate((key) => {
  if (session.useSession.getState().status !== "signedIn") return;
  const guilds = queryClient.getQueryData<Guild[]>(["guilds"]);
  const guildOf = (channelId: string) => {
    const guildId = mentionGuilds.get(channelId);
    return guildId && guilds?.some((g) => g.id === guildId) ? guildId : undefined;
  };
  const place = placeForKey(key as ConvKey, queryClient.getQueryData<Dm[]>(DMS_KEY)?.map((d) => d.id), guildOf);
  const parent = place?.channelId && threadParents.get(place.channelId);
  if (place && parent) {
    useNav.setState({ ...place, channelId: parent });
    void openThreadById(parent, place.channelId!);
  } else if (place) useNav.setState(place);
});

/** A thread event (pushed, or our own answer): its channel's lists, its starter message and the panel follow. */
export function threadChanged(event: ThreadEvent) {
  applyThreadEvent(queryClient, event);
  const { messageId, thread } = starterUpdate(event);
  if (messageId) chat.starter(channelKey(parentOf(event)), messageId, thread);
  if (threadPanel.apply(event) === "deleted") toast.push(t("thread.deletedNotice"));
}

/** A thread of `parentChannelId` matching `pick`, from its active list, else its archived one (fetched fresh). */
export async function findThread(parentChannelId: string, pick: (t: Thread) => boolean) {
  for (const archived of [false, true]) {
    const list = await queryClient
      .fetchQuery({ queryKey: threadsKey(parentChannelId, archived), queryFn: () => session.client.request<{ threads: Thread[] }>("GET", threadsPath(parentChannelId, archived)).then((r) => r.threads), staleTime: 0 })
      .catch(() => [] as Thread[]);
    const found = list.find(pick);
    if (found) return found;
  }
  return undefined;
}

/** Opens a thread we only know by id (a clicked notification); false when it is gone or out of sight. */
export async function openThreadById(parentChannelId: string, threadId: string) {
  const found = await findThread(parentChannelId, (t) => t.id === threadId);
  if (found) threadPanel.open(found);
  return !!found;
}

const voiceMoved = createVoiceMoved({
  voice,
  channelsOf: (guildId) =>
    queryClient.fetchQuery({ queryKey: ["guild", guildId], queryFn: () => session.client.request<GuildData>("GET", `/guilds/${guildId}`) }).then((g) => g.channels, () => undefined),
  notify: (text) => toast.push(text),
});

export const realtime = createRealtime({
  url: API_URL,
  getToken: (rejected) => session.client.accessToken(rejected),
  onEvent: (key, event) => chat.receive(key, event),
  onActivity: (key, event) => {
    if (event.type === "message:delete") return unread.deleted(key, event.id);
    if (event.type === "message:new") typing.stop(key, event.message.author.id);
    if (event.type === "message:pin") return void queryClient.invalidateQueries({ queryKey: ["pins", key] });
    if (event.type !== "message:new") return;
    unread.message(key, event.message, event.message.author.id, myId(), mentionInfo(key, event.message));
    notifyMessage(key, event.message);
  },
  onMention: (guildId, message, parentChannelId) => {
    const key = channelKey(message.channelId!);
    mentionGuilds.set(message.channelId!, guildId);
    if (parentChannelId) threadParents.set(message.channelId!, parentChannelId);
    profiles.seed([message.author], null);
    unread.message(key, message, message.author.id, myId(), mentionInfo(key, message, guildId));
    notifyMessage(key, message);
  },
  onTyping: (key, userId) => userId !== myId() && !isBlocked(userId) && typing.receive(key, userId),
  onRead: unread.serverRead,
  onSubscribed: (key) => void chat.catchUp(key),
  onRefused: (key) => {
    chat.markUnavailable(key);
    revalidateGuild(useNav.getState().guildId);
  },
  onSocial: (event) => {
    profiles.seed(event.type === "dm:new" ? [event.dm.user] : event.type === "dm:group" ? event.dm.participants : event.type === "friend:request" ? [event.from] : event.type === "friend:accepted" ? [event.user] : [], null);
    applySocialEvent(queryClient, event);
    presence.apply(event);
    // Removed from (or left, on another device) the group that is open: back to Friends, with a word why.
    if (event.type === "dm:removed" && useNav.getState().dmId === event.dmChannelId) {
      useNav.setState({ dmId: null });
      toast.push(t("group.removedNotice"));
    }
  },
  onMyStatus: presence.setMine,
  onGuild: (event) => applyGuildEvent(queryClient, event),
  onUserUpdated: userChanged,
  onGuildUpdated: (event) => applyGuildUpdated(queryClient, event),
  onWatched: (channelId) => void fetchVoiceSeats(channelId),
  onWatchRefused: () => revalidateGuild(useNav.getState().guildId),
  onVoiceUpdate: (channelId, seats) => voicePresence.update(channelId, seats),
  onCall: (event) => {
    if (event.type === "incoming") profiles.seed([event.from], null);
    calls.handle(event);
  },
  onVoiceMoved: (event) => void voiceMoved(event),
  onVoiceModerated: (event) => {
    const before = voice.moderated(event);
    if (before) for (const text of moderationNotices(before, event, event.byName)) toast.push(text);
  },
  onThread: threadChanged,
  // everything may have changed meanwhile: friends, DM list, blocks, permissions (the open conversation catches up separately)
  onReconnected: () => {
    unreadSync.refresh();
    void queryClient.invalidateQueries();
    void presence.loadMine();
  },
});

// the main process watches the system idle time; the server learns it through the socket
window.loop.onIdle((away) => realtime.setAway(away));

// our own name and avatar come with /me and the login answers
session.useSession.subscribe((s, prev) => s.user && s.user !== prev.user && profiles.seed([s.user], null));

// The socket lives exactly as long as the signed-in session.
session.useSession.subscribe((s, prev) => {
  if (s.status === "signedIn" && prev.status !== "signedIn") {
    if (s.user) {
      unread.start();
      unreadSync.refresh();
      firstRun.start(s.user.id);
    }
    void appSettings.load();
    void presence.loadMine();
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
