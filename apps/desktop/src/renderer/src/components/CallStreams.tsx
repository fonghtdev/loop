import { useStore } from "zustand";
import { t } from "../i18n/t";
import { voice } from "../lib/app";
import { useStreamStage } from "../lib/voice-hooks";
import { ScreenStage, StreamCard } from "./ScreenStage";
import { StreamTile } from "./StreamTile";

/** The streams of the DM call we are in, above the conversation: the same stage + strip as a voice room (nothing while nobody streams). */
export function CallStreams() {
  const people = useStore(voice.store, (s) => s.participants);
  const { stage, strip, staged, setPicked } = useStreamStage(people, true);
  if (!stage || !staged) return null;
  return (
    <div data-call-streams className="flex shrink-0 flex-col gap-3 px-5 py-3">
      <div className="flex h-[min(46vh,420px)] min-h-0 flex-col">{stage.watched ? <ScreenStage p={staged} /> : <StreamCard p={staged} />}</div>
      {strip.length > 0 && (
        <ul aria-label={t("voice.room.streams")} data-strip className="m-0 flex list-none gap-3 overflow-x-auto p-0">
          {strip.flatMap((x) => {
            const p = people.find((q) => q.userId === x.userId);
            return p ? [<StreamTile key={x.userId} p={p} watched={x.watched} onSelect={setPicked} className="w-44 shrink-0" />] : [];
          })}
        </ul>
      )}
    </div>
  );
}
