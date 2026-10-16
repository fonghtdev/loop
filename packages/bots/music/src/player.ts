import { sourceTag, type Track } from "./source.js";

export const MAX_QUEUE = 25;
/** A pause that nobody ends would hold the voice channel (and a stalled download) forever. */
export const PAUSE_LIMIT_MS = 10 * 60 * 1000;

/** The part of a VoiceConnection a player uses. */
export interface Connection {
  playPcm(pcm: AsyncIterable<Buffer>): Promise<void>;
  stop(): void;
  leave(): Promise<void>;
  on(event: "disconnect", listener: () => void): unknown;
}
export interface Source {
  /** `notify` reports a change of plan while it works (a source refuses us, so the next one is tried). */
  resolve(query: string, notify?: (text: string) => void): Promise<Track>;
  /** PCM s16le mono 48 kHz; kills what it started when `signal` aborts or the consumer stops reading. */
  open(track: Track, signal: AbortSignal): AsyncIterable<Buffer>;
  /** Gets a queued track ready (its stream URL) so it starts without a lookup; may be aborted. */
  prefetch?(track: Track, signal: AbortSignal): Promise<void>;
}

/** Queue and playback loop of one guild. Leaves the channel and calls `onClose` when the queue runs dry, on `stop()` or when the connection drops. */
export class GuildPlayer {
  current?: Track;
  private pending: Track[] = [];
  private running = false;
  private closed = false;
  private abort?: AbortController;
  private paused = false;
  private release?: () => void;
  private pauseTimer?: ReturnType<typeof setTimeout>;
  private warming?: { track: Track; ctl: AbortController };
  private readonly warmed = new WeakSet<Track>();

  constructor(
    private readonly conn: Connection,
    private readonly source: Source,
    private readonly say: (text: string) => void,
    private readonly onClose: () => void,
  ) {
    conn.on("disconnect", () => void this.stop());
  }

  get queued() {
    return this.pending;
  }

  get isPaused() {
    return this.paused;
  }

  /**
   * Holds the audio where it is: the connection's native buffer is only ~200 ms ahead, so it goes quiet almost at once, and
   * resuming continues from the same spot (the paced playback has no clock to catch up with). False when nothing plays or it already is paused.
   */
  pause() {
    if (!this.current || this.paused) return false;
    this.paused = true;
    this.pauseTimer = setTimeout(() => void this.stop(), PAUSE_LIMIT_MS);
    this.pauseTimer.unref?.();
    return true;
  }

  /** Continues a paused track. False when it was not paused. */
  resume() {
    if (!this.paused) return false;
    this.unpause();
    return true;
  }

  private unpause() {
    this.paused = false;
    clearTimeout(this.pauseTimer);
    this.release?.();
    this.release = undefined;
  }

  /** The source's audio, but it stops handing out chunks while paused (so playback starves and the download backs up) and wakes on resume / skip / stop. */
  private async *gated(pcm: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
    for await (const chunk of pcm) {
      this.warm(); // the current track is audible, so now the next one may use the (tiny) CPU
      while (this.paused) await new Promise<void>((wake) => (this.release = wake));
      yield chunk;
    }
  }

  /** Gets the track at the front of the queue ready in the background: one at a time, each track once, dropped when it is not wanted any more. */
  private warm() {
    const next = this.pending[0];
    if (!this.source.prefetch || !this.current || !next || this.warmed.has(next)) return;
    this.warming?.ctl.abort(); // the front changed (`next` was used): the old one is no longer first in line
    this.warmed.add(next);
    const job = (this.warming = { track: next, ctl: new AbortController() });
    void this.source.prefetch(next, job.ctl.signal).catch(() => {}).finally(() => this.warming === job && (this.warming = undefined));
  }

  private unwarm() {
    this.warming?.ctl.abort();
    this.warming = undefined;
  }

  /** Tracks ahead of the new one (0 = it plays now), or null when the queue is full. `next` puts it first in line instead of last. */
  add(track: Track, next = false) {
    if (this.pending.length >= MAX_QUEUE) return null;
    const ahead = (this.current ? 1 : 0) + (next ? 0 : this.pending.length);
    if (next) this.pending.unshift(track);
    else this.pending.push(track);
    if (!this.running) void this.run();
    else if (next) this.warm();
    return ahead;
  }

  /** Cuts the current track; the next one (if any) starts. False when nothing is playing. */
  skip() {
    if (!this.current) return false;
    this.cut();
    return true;
  }

  private cut() {
    this.unpause(); // a paused track that is skipped or stopped must not leave the gate waiting
    this.abort?.abort();
    this.conn.stop();
  }

  private async run() {
    this.running = true;
    while (!this.closed && (this.current = this.pending.shift())) {
      const track = this.current;
      const ctl = (this.abort = new AbortController());
      if (this.warming?.track === track) this.unwarm(); // it plays now: let playing do the lookup
      this.say(`Đang phát: ${track.title}${sourceTag(track)}`);
      try {
        await this.conn.playPcm(this.gated(this.source.open(track, ctl.signal)));
      } catch (e) {
        this.say(`Không phát được "${track.title}": ${(e as Error).message}`);
      }
      ctl.abort(); // a track that ended on its own has nothing left running, but make sure
    }
    this.current = undefined;
    this.running = false;
    await this.stop();
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.pending = [];
    this.current = undefined;
    this.unwarm();
    this.cut();
    this.onClose();
    await this.conn.leave().catch(() => {});
  }
}
