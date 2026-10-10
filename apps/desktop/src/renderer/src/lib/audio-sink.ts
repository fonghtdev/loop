/** What the voice session needs from the page to hear people: one <audio> element per subscribed remote track. */
export type AudioSink = {
  add(track: AudioTrackLike): void;
  remove(track: AudioTrackLike): void;
  /** Deafen: silences every element, now and for tracks that arrive later (nothing is unsubscribed). */
  setMuted(muted: boolean): void;
  clear(): void;
};
export type AudioTrackLike = { attach(): HTMLMediaElement; detach(el: HTMLMediaElement): unknown };

/** The DOM implementation: elements live in <body> (hidden) from subscribe to unsubscribe / leave. */
export function createAudioSink(): AudioSink {
  const elements = new Map<AudioTrackLike, HTMLMediaElement>();
  let muted = false;
  const drop = (track: AudioTrackLike, el: HTMLMediaElement) => {
    track.detach(el);
    el.remove();
  };
  return {
    add(track) {
      if (elements.has(track)) return;
      const el = track.attach();
      el.muted = muted;
      el.hidden = true;
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
    clear() {
      for (const [track, el] of elements) drop(track, el);
      elements.clear();
      muted = false;
    },
  };
}
