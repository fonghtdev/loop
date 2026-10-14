import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import type { AudioSource, Room } from "@livekit/rtc-node";
import type { Api } from "./api.js";
import { ApiError } from "./api.js";

const SAMPLE_RATE = 48000;
const FRAME_SAMPLES = SAMPLE_RATE / 100; // 10 ms mono
const FRAME_BYTES = FRAME_SAMPLES * 2;
const LEAD_MS = 200; // how far ahead of real time frames may be queued in the native buffer (capacity is 1000 ms)

type Rtc = typeof import("@livekit/rtc-node");

/** A bot in one voice channel: one outgoing audio track, fed with `playPcm`. Emits `disconnect` when LiveKit drops it. */
export class VoiceConnection extends EventEmitter {
  private playback?: AbortController;

  private constructor(
    private readonly rtc: Rtc,
    private readonly room: Room,
    private readonly source: AudioSource,
  ) {
    super();
    room.on(rtc.RoomEvent.Disconnected, () => this.emit("disconnect"));
  }

  /** Throws ApiError 403 when the bot may connect but not speak there. */
  static async join(api: Api, channelId: string) {
    const { token, url, canSpeak } = await api.voiceToken(channelId);
    if (!canSpeak) throw new ApiError(403, "The bot has no SPEAK permission in this channel");
    // loaded here so bots that never join voice do not start the native library
    const rtc = await import("@livekit/rtc-node");
    const room = new rtc.Room();
    const source = new rtc.AudioSource(SAMPLE_RATE, 1);
    try {
      await room.connect(url, token, { autoSubscribe: false, dynacast: false });
      const track = rtc.LocalAudioTrack.createAudioTrack("audio", source);
      await room.localParticipant!.publishTrack(track, new rtc.TrackPublishOptions({ source: rtc.TrackSource.SOURCE_MICROPHONE }));
    } catch (e) {
      await room.disconnect().catch(() => {});
      await source.close().catch(() => {});
      throw e;
    }
    return new VoiceConnection(rtc, room, source);
  }

  /**
   * Plays signed 16-bit little-endian mono 48 kHz PCM, paced in real time. Replaces whatever was playing.
   * Resolves when the audio has played out, or as soon as `stop()` / `leave()` cuts it (no error).
   */
  async playPcm(pcm: AsyncIterable<Int16Array | Buffer>) {
    this.stop();
    const mine = (this.playback = new AbortController());
    const { signal } = mine;
    let pending = Buffer.alloc(0);
    const push = async (bytes: Buffer) => {
      while (this.source.queuedDuration > LEAD_MS) {
        if (signal.aborted) return;
        await sleep(10);
      }
      if (signal.aborted) return;
      const samples = new Int16Array(FRAME_SAMPLES);
      Buffer.from(samples.buffer).set(bytes);
      try {
        await this.source.captureFrame(new this.rtc.AudioFrame(samples, SAMPLE_RATE, 1, FRAME_SAMPLES));
      } catch (e) {
        if (!signal.aborted) throw e; // a frame in flight when leave() closed the source
      }
    };
    try {
      for await (const chunk of pcm) {
        pending = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]);
        while (pending.length >= FRAME_BYTES && !signal.aborted) {
          await push(pending.subarray(0, FRAME_BYTES));
          pending = pending.subarray(FRAME_BYTES);
        }
        if (signal.aborted) return;
      }
      if (pending.length) await push(pending); // the tail is padded with silence
      if (!signal.aborted) await this.source.waitForPlayout();
    } finally {
      if (this.playback === mine) this.playback = undefined;
    }
  }

  /** Cuts the current audio now; the pending `playPcm` resolves. */
  stop() {
    this.playback?.abort();
    this.playback = undefined;
    this.source.clearQueue();
  }

  async leave() {
    this.stop();
    await this.room.disconnect();
    await this.source.close();
  }
}
