import { createHash } from "node:crypto";
import { AccessToken, TokenVerifier } from "livekit-server-sdk";
import { AudioSource, LocalAudioTrack, Room, RoomEvent, TrackPublishOptions, TrackSource } from "@livekit/rtc-node";
import { expect, vi } from "vitest";
import { createLivekit } from "../src/voice/livekit.js";
import { caller, env } from "./helpers.js";

export const testLivekit = createLivekit(env.livekit);
export const { apiKey, apiSecret } = env.livekit;

export const decodeToken = (token: string) => new TokenVerifier(apiKey, apiSecret).verify(token);

type Join = { token: string; url: string };
const rooms: Room[] = [];

/** A real LiveKit participant (media-connected); `disconnectAll` in afterEach. */
export async function joinAs({ token, url }: Join) {
  const room = new Room();
  rooms.push(room);
  await room.connect(url, token, { autoSubscribe: true });
  return room;
}

export async function disconnectAll() {
  await Promise.all(rooms.splice(0).map((r) => r.disconnect().catch(() => {})));
}

/**
 * Publishes a (silent) microphone track. When LiveKit refuses (no SPEAK) the client's publish promise just
 * stays pending, so this gives up after `waitMs` and says "refused" instead of hanging the test.
 */
export async function publishMic(room: Room, waitMs = 2000) {
  const track = LocalAudioTrack.createAudioTrack("mic", new AudioSource(48000, 1));
  const publishing = room
    .localParticipant!.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }))
    .then(() => "published" as const, () => "refused" as const);
  return Promise.race([publishing, new Promise<"refused">((r) => setTimeout(() => r("refused"), waitMs))]);
}

export { RoomEvent };

/** Polls the real LiveKit until `check` holds (revocations are applied over its API, not instantly). */
export const eventually = <T>(check: () => Promise<T> | T) => vi.waitFor(check, { timeout: 8000, interval: 100 });

export const identities = async (room: string) => (await testLivekit.participants(room)).map((s) => s.userId).sort();
export const expectInRoom = (room: string, ids: string[]) => eventually(async () => expect(await identities(room)).toEqual([...ids].sort()));

/** What LiveKit itself would POST: a JSON body and an Authorization JWT carrying the body's sha256. */
export async function signedWebhook(event: object, sign = true) {
  const body = JSON.stringify({ id: "EV_test", createdAt: Math.floor(Date.now() / 1000), ...event });
  const token = new AccessToken(apiKey, apiSecret);
  token.sha256 = createHash("sha256").update(body).digest("base64");
  return { body, authorization: sign ? await token.toJwt() : undefined };
}

export const webhookHeaders = (authorization?: string) => ({
  "content-type": "application/webhook+json",
  ...(authorization ? { authorization } : {}),
});

type App = Parameters<typeof caller>[0];
type User = { token: string; id: string; name: string };

export async function addVoiceChannel(app: App, owner: User, guildId: string, name = "lounge") {
  const res = await caller(app)("POST", `/guilds/${guildId}/channels`, owner.token, { name, type: "VOICE" });
  return res.json() as { id: string };
}

export const requestToken = (app: App, user: User, channelId: string) =>
  caller(app)("POST", `/channels/${channelId}/voice/token`, user.token);
