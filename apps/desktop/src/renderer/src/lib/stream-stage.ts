/** Which stream is on the room's big stage and which stay in the strip below it (pure; the room only draws the result). */
export type StreamRef = { userId: string; isLocal: boolean };
export type StageStream = StreamRef & { watched: boolean };
export type StageModel = { stage: StageStream | null; strip: StageStream[] };

/**
 * `streams`: every stream in the room (our own once it has a picture, others' while published), in display order.
 * `watching`: whose streams we asked to watch. `picked`: the stream the viewer put on stage by hand.
 * One stream on stage: the picked one if it still exists, else the first we can see (own or watched), else the first
 * one (shown as the "Xem stream" invitation). The rest are the strip. No streams: no stage (the plain grid).
 */
export function stageModel(streams: StreamRef[], watching: readonly string[], picked: string | null): StageModel {
  const all: StageStream[] = streams.map((s) => ({ ...s, watched: s.isLocal || watching.includes(s.userId) }));
  const stage = all.find((s) => s.userId === picked) ?? all.find((s) => s.watched) ?? all[0] ?? null;
  return { stage, strip: all.filter((s) => s !== stage) };
}
