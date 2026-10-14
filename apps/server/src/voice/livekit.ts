import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from "livekit-server-sdk";
import type { Env } from "../env.js";

declare module "fastify" {
  interface FastifyInstance {
    livekit: Livekit;
  }
}

export const TOKEN_TTL_SECONDS = 600;
const REQUEST_TIMEOUT_SECONDS = 5;

export type Rights = { speak: boolean; video: boolean; stream: boolean };
// No participant count: LiveKit refreshes Room.numParticipants only every few seconds; `participants()` is live.
export type RoomInfo = { name: string; maxParticipants: number };
export type Seat = Rights & { userId: string; username: string; sharing: boolean };
export type RoomEvent = { type: string; room: string | undefined; userId: string | undefined; screenShare: boolean };

const isNotFound = (e: unknown) => (e as { status?: number })?.status === 404;
/** Publishing sources a set of rights allows; screen share (with its audio) only with stream. */
const sourcesOf = ({ speak, video, stream }: Rights) => [
  ...(speak ? [TrackSource.MICROPHONE] : []),
  ...(video ? [TrackSource.CAMERA] : []),
  ...(stream ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : []),
];

/**
 * The only module that talks to LiveKit (a Docker container in dev/test, LiveKit Cloud in production): tokens,
 * room administration and webhook verification. Everything else sees plain objects, never SDK types.
 */
export function createLivekit({ url, apiUrl, apiKey, apiSecret }: Env["livekit"]) {
  const client = new RoomServiceClient(apiUrl, apiKey, apiSecret, { requestTimeout: REQUEST_TIMEOUT_SECONDS });
  const receiver = new WebhookReceiver(apiKey, apiSecret);
  const toRoom = (r: { name: string; maxParticipants: number }): RoomInfo => ({ name: r.name, maxParticipants: r.maxParticipants });
  /** A missing target is already the state we want. */
  const ignoreMissing = async (op: Promise<unknown>) => {
    try {
      await op;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  };

  return {
    /** What clients connect to (may differ from the address the server calls). */
    url,

    /** Idempotent: an existing room keeps the settings it was created with. */
    async ensureRoom(name: string, maxParticipants: number, timeouts: { emptyTimeout: number; departureTimeout: number }) {
      return toRoom(await client.createRoom({ name, maxParticipants, ...timeouts }));
    },

    /** Rooms that currently exist (LiveKit drops empty ones after their timeout); no names = all rooms, so callers must not pass an empty list meaning "none". */
    async listRooms(names?: string[]) {
      return (await client.listRooms(names)).map(toRoom);
    },

    /** [] when the room does not exist (LiveKit drops empty rooms). */
    async participants(room: string): Promise<Seat[]> {
      return (await client.listParticipants(room)).map((p) => {
        const sources = p.permission?.canPublishSources ?? [];
        const allows = (source: TrackSource) => !!p.permission?.canPublish && (!sources.length || sources.includes(source));
        return {
          userId: p.identity,
          username: p.name,
          speak: allows(TrackSource.MICROPHONE),
          video: allows(TrackSource.CAMERA),
          stream: allows(TrackSource.SCREEN_SHARE),
          sharing: p.tracks.some((t) => t.source === TrackSource.SCREEN_SHARE),
        };
      });
    },

    /** Join token: one seat per identity (a second connection replaces the first), no data channel. */
    token(room: string, user: { id: string; username: string }, rights: Rights) {
      const token = new AccessToken(apiKey, apiSecret, { identity: user.id, name: user.username, ttl: TOKEN_TTL_SECONDS });
      token.addGrant({
        roomJoin: true,
        room,
        canSubscribe: true,
        canPublishData: false,
        // ponytail: cosmetic only. Clients publish their own deafen flag as participant metadata so others can draw the
        // headphones-off icon; never use it for a decision (a client may lie about its own icon). Not part of
        // `Rights`, so setRights below repeats it (an update replaces the whole permission).
        canUpdateOwnMetadata: true,
        canPublish: sourcesOf(rights).length > 0,
        canPublishSources: sourcesOf(rights),
      });
      return token.toJwt();
    },

    /** Applies at once on a live connection: LiveKit unpublishes what is no longer allowed. */
    setRights: (room: string, userId: string, rights: Rights) =>
      ignoreMissing(
        client.updateParticipant(room, userId, {
          permission: {
            canSubscribe: true,
            canPublishData: false,
            canUpdateMetadata: true, // the permission-side name of the token's canUpdateOwnMetadata
            canPublish: sourcesOf(rights).length > 0,
            canPublishSources: sourcesOf(rights),
          },
        }),
      ),

    removeParticipant: (room: string, userId: string) => ignoreMissing(client.removeParticipant(room, userId)),
    deleteRoom: (room: string) => ignoreMissing(client.deleteRoom(room)),

    /** Throws unless the Authorization header is LiveKit's signature over exactly this raw body. */
    async verifyWebhook(rawBody: string, authorization: string | undefined): Promise<RoomEvent> {
      if (!authorization) throw new Error("missing signature");
      const event = await receiver.receive(rawBody, authorization);
      return { type: event.event, room: event.room?.name, userId: event.participant?.identity, screenShare: event.track?.source === TrackSource.SCREEN_SHARE };
    },
  };
}

export type Livekit = ReturnType<typeof createLivekit>;
