/**
 * Whether the microphone transmits. `micEnabled` is the user's own choice (the mute button); push-to-talk can only
 * narrow it, never widen it: a muted or deafened user stays silent whatever the key does.
 */
export const micLive = ({ micEnabled, deafened, ptt, pttHeld }: { micEnabled: boolean; deafened: boolean; ptt: boolean; pttHeld: boolean }) => micEnabled && !deafened && (!ptt || pttHeld);
