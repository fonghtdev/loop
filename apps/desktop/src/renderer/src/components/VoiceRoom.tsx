import { Permission } from "@loop/shared";
import { SpeakerHigh } from "@phosphor-icons/react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { voice } from "../lib/app";
import { useGuild, usePermissions } from "../lib/queries";
import { stageModel } from "../lib/stream-stage";
import { reconcileTiles, TILE_GAP, tileLayout, type Tile } from "../lib/voice-grid";
import { isActive, useVoiceParticipants } from "../lib/voice-hooks";
import { Button } from "./Button";
import { VoiceArt } from "./Illustrations";
import { ParticipantTile } from "./ParticipantTile";
import { ScreenStage, StreamCard } from "./ScreenStage";
import { ColumnHeader, EmptyState } from "./States";
import { StreamTile } from "./StreamTile";
import { Tooltip } from "./Tooltip";

/** The content size of an element, measured before paint and again on every resize (not per frame). */
function useContentSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** The tiles to render: the people present plus those still playing their exit; `drop` removes a finished leaver. */
function useTiles(people: Tile["p"][]) {
  const [tiles, setTiles] = useState<Tile[]>(() => reconcileTiles([], people));
  const [seen, setSeen] = useState(people);
  if (seen !== people) {
    setSeen(people);
    setTiles((prev) => reconcileTiles(prev, people));
  }
  const drop = useCallback((id: string) => setTiles((prev) => prev.filter((x) => !(x.p.userId === id && x.state === "leave"))), []);
  return [tiles, drop] as const;
}

/** The main area of a selected voice channel: who is in it, and the Join button until we are. */
export function VoiceRoom({ guildId, channelId }: { guildId: string; channelId: string }) {
  const name = useGuild(guildId).data?.channels.find((c) => c.id === channelId)?.name ?? "";
  const canConnect = usePermissions(guildId, channelId).can(Permission.CONNECT);
  const target = useStore(voice.store, (s) => s.target);
  const status = useStore(voice.store, (s) => s.status);
  const people = useVoiceParticipants(channelId);
  const here = target?.kind === "channel" && target.id === channelId && isActive(status);
  const busyElsewhere = isActive(status) && !here;
  const [box, size] = useContentSize<HTMLDivElement>();
  const [tiles, drop] = useTiles(people);
  const watching = useStore(voice.store, (s) => s.watching);
  // our own share shows as soon as it has a picture; someone else's only after Watch (and only in the room we are in)
  const shared = people.filter((p) => (p.isLocal ? !!p.screen : here && !!p.sharing));
  const layout = tileLayout(tiles.length, size.w, size.h);
  // one stream on the big stage (the viewer's pick, else the first we can see); the other streams get a tile in the strip
  const [picked, setPicked] = useState<string | null>(null);
  const { stage, strip } = stageModel(
    shared.map((p) => ({ userId: p.userId, isLocal: !!p.isLocal })),
    watching,
    picked,
  );
  const staged = shared.find((p) => p.userId === stage?.userId);

  return (
    <>
      <ColumnHeader>
        <SpeakerHigh aria-hidden="true" className="shrink-0 text-ink-muted" />
        <Tooltip label={name}>
          <h1 className="min-w-0 truncate">{name}</h1>
        </Tooltip>
        <span className="numeric shrink-0 text-caption font-normal text-ink-muted">{t("voice.room.count", { count: String(people.length) })}</span>
      </ColumnHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        {!here && (
          <div className="flex flex-col items-start gap-3 px-5 pt-4">
            <Button type="button" disabled={!canConnect} onClick={() => void voice.joinChannel(channelId, name, guildId)}>
              <SpeakerHigh aria-hidden="true" />
              {t("voice.room.join")}
            </Button>
            {busyElsewhere && <p className="text-small text-ink-muted">{t("voice.room.elsewhere")}</p>}
            {!canConnect && <p className="text-small text-ink-muted">{t("voice.room.joinNoConnect")}</p>}
          </div>
        )}
        {stage && staged && <div className="flex min-h-0 flex-[3] flex-col gap-3 px-5 pt-5">{stage.watched ? <ScreenStage p={staged} /> : <StreamCard p={staged} />}</div>}
        <div ref={box} className={stage ? "shrink-0 overflow-x-auto px-5 py-4" : "flex min-h-0 flex-1 flex-col overflow-y-auto p-5"}>
          {stage ? (
            <ul aria-label={t("voice.room.people")} data-strip className="m-0 flex w-fit min-w-full list-none justify-center gap-3 p-0">
              {tiles.flatMap((tile) => {
                const stream = strip.find((x) => x.userId === tile.p.userId);
                return [
                  <ParticipantTile key={tile.p.userId} tile={tile} guildId={guildId} onGone={drop} className="w-44 shrink-0" />,
                  ...(stream ? [<StreamTile key={`stream-${tile.p.userId}`} p={tile.p} watched={stream.watched} onSelect={setPicked} className="w-44 shrink-0" />] : []),
                ];
              })}
            </ul>
          ) : tiles.length === 0 ? (
            !here && <EmptyState page art={<VoiceArt />} title={t("voice.room.emptyTitle")} body={t("voice.room.empty")} />
          ) : (
            <ul aria-label={t("voice.room.people")} data-cols={layout.cols} style={{ gridTemplateColumns: `repeat(${layout.cols}, ${layout.width}px)`, gap: TILE_GAP }} className="m-auto grid">
              {tiles.map((tile) => (
                <ParticipantTile key={tile.p.userId} tile={tile} guildId={guildId} onGone={drop} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
