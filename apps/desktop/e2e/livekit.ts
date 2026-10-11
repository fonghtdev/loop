import { createHmac } from "node:crypto";
import { AudioSource, LocalAudioTrack, Room, RoomEvent, TrackKind, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import { api, type Session } from "./helpers";

// "Other participants" of the voice specs: real LiveKit clients (rtc-node) with tokens from the real endpoints.
export type Token = { token: string; url: string; room: string; canSpeak: boolean; canVideo: boolean };
export const channelToken = (s: Session, channelId: string) => api<Token>(s.token, "POST", `/channels/${channelId}/voice/token`);
export const callToken = (s: Session, dmId: string, video = false) => api<Token>(s.token, "POST", `/dms/${dmId}/call`, { video });

export type Peer = Awaited<ReturnType<typeof joinRoom>>;
const peers: Room[] = [];

/** Connects to the room of a token and (by default) publishes a silent microphone, so the app has audio to play. */
export async function joinRoom(t: Token, { mic = true }: { mic?: boolean } = {}) {
  const room = new Room();
  peers.push(room);
  // rtc-node's `publication.muted` does not follow remote mute changes, the events do
  const mutedSids = new Set<string>();
  room.on(RoomEvent.TrackMuted, (pub) => mutedSids.add(pub.sid!));
  room.on(RoomEvent.TrackUnmuted, (pub) => mutedSids.delete(pub.sid!));
  await room.connect(t.url, t.token, { autoSubscribe: true, dynacast: false });
  const publishMic = async () => {
    const track = LocalAudioTrack.createAudioTrack("mic", new AudioSource(48000, 1));
    await room.localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  };
  if (mic) await publishMic();
  /** What this peer sees of another participant: subscribed tracks by kind, and whether the audio is muted. */
  const sees = (identity: string) => {
    const p = room.remoteParticipants.get(identity);
    const pubs = p ? [...p.trackPublications.values()] : [];
    const audio = pubs.filter((x) => x.kind === TrackKind.KIND_AUDIO);
    const video = pubs.filter((x) => x.kind === TrackKind.KIND_VIDEO);
    return {
      present: !!p,
      audio: audio.filter((x) => x.track).length,
      audioMuted: audio.length ? audio.every((x) => mutedSids.has(x.sid!)) : undefined,
      video: video.filter((x) => x.track && !mutedSids.has(x.sid!)).length, // switching the camera off mutes the track
    };
  };
  /** The peer silences its microphone (rtc-node cannot mute a track, so it unpublishes it) or brings it back; and publishes participant metadata (the deafen flag). */
  const muteMic = async (on: boolean) => {
    const pub = [...room.localParticipant!.trackPublications.values()].find((x) => x.source === TrackSource.SOURCE_MICROPHONE);
    if (!on) return pub ? undefined : publishMic();
    if (pub) await room.localParticipant!.unpublishTrack(pub.sid!);
  };
  const setMetadata = (m: string) => room.localParticipant!.updateMetadata(m);
  return { room, sees, muteMic, setMetadata, identities: () => [...room.remoteParticipants.keys()].sort(), leave: () => room.disconnect().catch(() => undefined) };
}

export async function leaveAll() {
  await Promise.all(peers.splice(0).map((r) => r.disconnect().catch(() => undefined)));
}

// ---- LiveKit admin (a tiny HS256 token + Twirp call; only to pre-create a small room for the "full" test) ----
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
function adminJwt(room?: string, key = "devkey", secret = process.env.LIVEKIT_API_SECRET ?? "loop-dev-livekit-secret-0123456789abcdef") {
  const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: key, exp: Math.floor(Date.now() / 1000) + 60, video: { roomCreate: true, roomList: true, roomAdmin: true, room } })}`;
  return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
}
export async function livekitAdmin(method: string, body: object) {
  const res = await fetch(`http://127.0.0.1:7880/twirp/livekit.RoomService/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminJwt((body as { room?: string }).room)}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`livekit ${method} ${res.status} ${await res.text()}`);
  return res.json() as Promise<any>;
}
export const createSmallRoom = (name: string, max: number) => livekitAdmin("CreateRoom", { name, max_participants: max, empty_timeout: 60 });
export const deleteRoom = (name: string) => livekitAdmin("DeleteRoom", { room: name }).catch(() => undefined);
