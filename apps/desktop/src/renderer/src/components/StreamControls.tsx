import { ArrowsClockwise, Check, Monitor, MonitorArrowUp, Sliders, VideoCamera, X } from "@phosphor-icons/react";
import { useState } from "react";
import { t } from "../i18n/t";
import { voice } from "../lib/app";
import type { ShareChoice } from "../lib/golive";
import { streamMenu } from "../lib/stream-menu";
import { MenuItem, RowMenu } from "./RowMenu";
import { Tooltip } from "./Tooltip";

const resolutionLabel = (r: ShareChoice["quality"]["resolution"]) => (r === "native" ? t("golive.native") : `${r}p`);
const spacer = <span aria-hidden="true" className="size-5" />;
const group = "px-2.5 pt-1 pb-0.5 text-caption font-semibold text-ink-muted";

/** A monitor with an X on its screen: "end the stream". */
function StopStreamIcon() {
  return (
    <span aria-hidden="true" className="relative grid place-items-center">
      <Monitor />
      <X size={9} weight="bold" className="absolute top-[4px]" />
    </span>
  );
}

/** The top of the voice panel while we stream: what is shared (its name, never cropped to a fixed width) and the stop button. */
export function SharingCard({ stream }: { stream: ShareChoice }) {
  const Icon = stream.source.kind === "device" ? VideoCamera : Monitor;
  return (
    <div role="group" aria-label={t("voice.sharing")} data-sharing-card className="flex items-center gap-2.5 rounded-control bg-surface-1 p-1.5 pl-2">
      <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-control bg-moss-900 text-moss-200">
        <Icon />
      </span>
      <div className="min-w-0 flex-1">
        <Tooltip label={stream.label}>
          <p className="truncate text-small font-semibold text-ink">{stream.label}</p>
        </Tooltip>
        <p className="truncate text-caption text-ink-muted">
          {resolutionLabel(stream.quality.resolution)} · {t("golive.fpsN", { n: String(stream.quality.fps) })}
        </p>
      </div>
      <Tooltip label={t("voice.stream.end")}>
        <button type="button" aria-label={t("voice.stream.end")} onClick={() => void voice.stopScreen()} className="grid size-10 shrink-0 place-items-center rounded-control bg-danger-bg text-danger transition-colors duration-(--duration-fast) hover:bg-danger hover:text-on-moss active:scale-[.98]">
          <StopStreamIcon />
        </button>
      </Tooltip>
    </div>
  );
}

/** The share button while streaming: instead of toggling it opens the stream's menu (stop, change source, quality, sound). */
export function StreamMenu({ stream }: { stream: ShareChoice }) {
  const [qualityOpen, setQualityOpen] = useState(false);
  return (
    <span className="flex flex-1">
      <RowMenu id="stream-menu" label={t("voice.stream.options")} align="left" width="w-64" size="h-10 w-full" className="bg-moss-900! text-moss-200! hover:brightness-125" trigger={<MonitorArrowUp aria-hidden="true" />} onOpen={() => setQualityOpen(false)}>
        {(close) =>
          streamMenu(stream, window.loop.platform).map((row) => {
            switch (row.id) {
              case "stop":
                return <MenuItem key={row.id} danger icon={<StopStreamIcon />} label={t("voice.stream.end")} onClick={() => (close(), void voice.stopScreen())} />;
              case "change":
                return <MenuItem key={row.id} icon={<ArrowsClockwise aria-hidden="true" />} label={t("voice.stream.change")} onClick={() => (close(), void voice.startScreen())} />;
              case "resolution":
                return (
                  <div key={row.id}>
                    <MenuItem icon={<Sliders aria-hidden="true" />} label={t("voice.stream.quality")} expanded={qualityOpen} onClick={() => setQualityOpen(!qualityOpen)} />
                    {qualityOpen && (
                      <>
                        <p className={group}>{t("golive.resolution")}</p>
                        {row.options.map((o) => (
                          <MenuItem key={o.value} selected={o.checked} icon={o.checked ? <Check aria-hidden="true" /> : spacer} label={resolutionLabel(o.value)} onClick={() => void voice.setStreamQuality({ ...stream.quality, resolution: o.value })} />
                        ))}
                      </>
                    )}
                  </div>
                );
              case "fps":
                return qualityOpen ? (
                  <div key={row.id}>
                    <p className={group}>{t("golive.fps")}</p>
                    {row.options.map((o) => (
                      <MenuItem key={o.value} selected={o.checked} icon={o.checked ? <Check aria-hidden="true" /> : spacer} label={t("golive.fpsN", { n: String(o.value) })} onClick={() => void voice.setStreamQuality({ ...stream.quality, fps: o.value })} />
                    ))}
                  </div>
                ) : null;
              case "audio":
                return (
                  <div key={row.id}>
                    <MenuItem selected={row.checked} disabled={!!row.blocked} icon={row.checked ? <Check aria-hidden="true" /> : spacer} label={t("voice.stream.audio")} onClick={() => void voice.setStreamAudio(!row.checked)} />
                    {row.blocked && <p className="px-2.5 pb-1 text-caption text-ink-muted">{t(row.blocked === "device" ? "golive.audioDevice" : "golive.audioOs")}</p>}
                  </div>
                );
            }
          })
        }
      </RowMenu>
    </span>
  );
}
