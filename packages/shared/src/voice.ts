import { z } from "zod";

/** Seats in one guild voice channel (LiveKit enforces it per room); a DM call is always two. */
export const MAX_VOICE_PARTICIPANTS = 25;
export const MAX_DM_CALL_PARTICIPANTS = 2;

/** Body is optional: a bodyless POST starts an audio call. `video` only tells the other side what to expect. */
export const startCallSchema = z.object({ video: z.boolean().default(false) });
