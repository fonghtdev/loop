import { Permission } from "@loop/shared";
import { SpeakerHigh } from "@phosphor-icons/react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { voice } from "../lib/app";
import { useGuild, usePermissions } from "../lib/queries";
import { isActive, useVoiceParticipants } from "../lib/voice-hooks";
import { Button } from "./Button";
import { VoiceArt } from "./Illustrations";
import { ParticipantTile } from "./ParticipantTile";
import { ColumnHeader, EmptyState } from "./States";

/** The main area of a selected voice channel: who is in it, and the Join button until we are. */
export function VoiceRoom({ guildId, channelId }: { guildId: string; channelId: string }) {
  const name = useGuild(guildId).data?.channels.find((c) => c.id === channelId)?.name ?? "";
  const canConnect = usePermissions(guildId, channelId).can(Permission.CONNECT);
  const target = useStore(voice.store, (s) => s.target);
  const status = useStore(voice.store, (s) => s.status);
  const people = useVoiceParticipants(channelId);
  const here = target?.kind === "channel" && target.id === channelId && isActive(status);
  const busyElsewhere = isActive(status) && !here;

  return (
    <>
      <ColumnHeader>
        <SpeakerHigh aria-hidden="true" className="shrink-0 text-ink-muted" />
        <h1 title={name} className="min-w-0 truncate">
          {name}
        </h1>
        <span className="shrink-0 text-xs font-normal text-ink-muted">{t("voice.room.count", { count: String(people.length) })}</span>
      </ColumnHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {!here && (
          <div className="flex flex-col items-start gap-3 p-4">
            <Button type="button" disabled={!canConnect} title={canConnect ? undefined : t("voice.room.joinNoConnect")} onClick={() => void voice.joinChannel(channelId, name)}>
              <SpeakerHigh aria-hidden="true" />
              {t("voice.room.join")}
            </Button>
            {busyElsewhere && <p className="text-sm text-ink-muted">{t("voice.room.elsewhere")}</p>}
            {!canConnect && <p className="text-sm text-ink-muted">{t("voice.room.joinNoConnect")}</p>}
          </div>
        )}
        {people.length === 0 ? (
          !here && <EmptyState page art={<VoiceArt />} title={t("voice.room.emptyTitle")} body={t("voice.room.empty")} />
        ) : (
          <ul aria-label={t("voice.room.people")} className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))] content-start gap-3 p-4">
            {people.map((p) => (
              <ParticipantTile key={p.userId} p={p} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
