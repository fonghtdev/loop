/** What the voice session needs from the page to hear people: one <audio> element per subscribed remote track. */
export type AudioSink = {
  add(track: AudioTrackLike): void;
  remove(track: AudioTrackLike): void;
  /** Deafen: silences every element, now and for tracks that arrive later (nothing is unsubscribed). */
  setMuted(muted: boolean): void;
  /** One track's own loudness, 0..2 (a stream's slider, a person's slider); 1 = unchanged. Above 1 goes through Web Audio. Independent of the global deafen. */
  setVolume(track: AudioTrackLike, volume: number): void;
  /** The speaker (an output device id from enumerateDevices, null = system default): now and for tracks that arrive later. */
  setOutput(deviceId: string | null): void;
  clear(): void;
};
export type AudioTrackLike = { attach(): HTMLMediaElement; detach(el: HTMLMediaElement): unknown };

/** The DOM implementation: elements live in <body> (hidden) from subscribe to unsubscribe / leave. */
export function createAudioSink(): AudioSink {
  const elements = new Map<AudioTrackLike, HTMLMediaElement>();
  let muted = false;
  let output: string | null = null; // survives clear(): it is the user's choice, not the session's
  // HTMLMediaElement.volume stops at 1, so a track set above 1 is routed through a GainNode for good (an element can be wired to Web Audio only once).
  // ponytail: once boosted its sound leaves through the AudioContext (follows `output` via setSinkId, which also needs Chromium 110+), and `muted` no longer mutes
  // it by itself: the voice session sets every gain to 0 on deafen.
  let ctx: (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null = null;
  const gains = new Map<AudioTrackLike, GainNode>();
  const boost = (track: AudioTrackLike, el: HTMLMediaElement, volume: number) => {
    if (!ctx) {
      ctx = new AudioContext();
      void ctx.setSinkId?.(output ?? "").catch(() => undefined);
    }
    const gain = ctx.createGain();
    gain.gain.value = volume;
    ctx.createMediaElementSource(el).connect(gain).connect(ctx.destination);
    el.volume = 1;
    gains.set(track, gain);
  };
  const route = (el: HTMLMediaElement) => void (el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(output ?? "").catch(() => undefined);
  const drop = (track: AudioTrackLike, el: HTMLMediaElement) => {
    gains.get(track)?.disconnect();
    gains.delete(track);
    track.detach(el);
    el.remove();
  };
  return {
    add(track) {
      if (elements.has(track)) return;
      const el = track.attach();
      el.muted = muted;
      el.hidden = true;
      route(el);
      document.body.appendChild(el);
      elements.set(track, el);
    },
    remove(track) {
      const el = elements.get(track);
      if (!el) return;
      drop(track, el);
      elements.delete(track);
    },
    setMuted(m) {
      muted = m;
      for (const el of elements.values()) el.muted = m;
    },
    setVolume(track, volume) {
      const el = elements.get(track);
      const gain = gains.get(track);
      if (gain) gain.gain.value = volume;
      else if (el && volume > 1) boost(track, el, volume);
      else if (el) el.volume = volume;
    },
    setOutput(id) {
      output = id;
      void ctx?.setSinkId?.(id ?? "").catch(() => undefined);
      for (const el of elements.values()) route(el);
    },
    clear() {
      for (const [track, el] of elements) drop(track, el);
      elements.clear();
      muted = false;
    },
  };
}
