import { z } from "zod";

/** Seats in one guild voice channel (LiveKit enforces it per room); a DM call is always two. */
export const MAX_VOICE_PARTICIPANTS = 25;
export const MAX_DM_CALL_PARTICIPANTS = 2;

/** Body is optional: a bodyless POST starts an audio call. `video` only tells the other side what to expect. */
export const startCallSchema = z.object({ video: z.boolean().default(false) });

/**
 * PUT /channels/:channelId/voice/members/:userId/state: the wanted server-side state (true = muted / deafened).
 * At least one key. A server deafen also takes the microphone (nobody talks into a room they cannot hear).
 */
export const voiceStateSchema = z
  .object({ mute: z.boolean(), deafen: z.boolean() })
  .partial()
  .strict()
  .refine((b) => b.mute !== undefined || b.deafen !== undefined, "mute or deafen required");

/** Socket `voice:moderated` to the member acted on (their user room), after a moderator changed their server state. */
export type VoiceModeratedEvent = { channelId: string; serverMute: boolean; serverDeafen: boolean; by: { id: string; username: string } };
