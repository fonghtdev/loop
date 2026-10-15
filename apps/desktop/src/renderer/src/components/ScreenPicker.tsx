import { VideoCamera } from "@phosphor-icons/react";
import { useState } from "react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { goLivePrefs, screenPicker } from "../lib/app";
import { audioAllowed, FPS_CHOICES, partitionSources, RESOLUTIONS, type Fps, type Resolution } from "../lib/golive";
import type { ScreenSource, ShareDevice } from "../lib/screen-picker";
import { Button } from "./Button";
import { Dialog, DialogActions } from "./Dialog";
import { Segmented } from "./Segmented";
import { Switch } from "./Switch";

type Tab = "apps" | "screens" | "devices";

/** Go Live: what to share (an application, a whole screen or a camera / capture card), at what quality, with or without the system sound. */
export function ScreenPicker() {
  const open = useStore(screenPicker.store, (s) => s.open);
  return (
    <Dialog open={!!open} onClose={screenPicker.cancel} title={t("golive.title")} wide hideTitle>
      {open && <GoLiveForm sources={open.sources} devices={open.devices} />}
    </Dialog>
  );
}

const pick = "flex w-full flex-col gap-1.5 rounded-control bg-surface-1 p-2 text-left transition-colors duration-(--duration-fast) hover:bg-surface-4 aria-pressed:bg-surface-4 aria-pressed:ring-2 aria-pressed:ring-moss-400";

function GoLiveForm({ sources, devices }: { sources: ScreenSource[]; devices: ShareDevice[] }) {
  const start = goLivePrefs.get();
  const [tab, setTab] = useState<Tab>("apps");
  const [selected, setSelected] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution>(start.resolution);
  const [fps, setFps] = useState<Fps>(start.fps);
  const [audio, setAudio] = useState(start.audio);
  const { screens, windows } = partitionSources(sources);
  const canAudio = audioAllowed(tab === "devices" ? "device" : "display", window.loop.platform);

  const screenLabel = (i: number) => (screens.length > 1 ? t("golive.screenN", { n: String(i + 1) }) : t("golive.screenOne"));
  const confirm = () => {
    if (!selected) return;
    const label =
      tab === "devices" ? (devices.find((d) => d.id === selected)?.label ?? t("golive.deviceFallback")) : tab === "screens" ? screenLabel(screens.findIndex((s) => s.id === selected)) : (windows.find((s) => s.id === selected)?.name ?? "");
    const source = tab === "devices" ? ({ kind: "device", deviceId: selected } as const) : ({ kind: "display", id: selected } as const);
    screenPicker.confirm({ source, quality: { resolution, fps }, audio: canAudio && audio, label }, { resolution, fps, audio });
  };
  const thumbs = (list: ScreenSource[], label: (s: ScreenSource, i: number) => string, empty: string) =>
    list.length === 0 ? (
      <p className="text-small text-ink-muted">{empty}</p>
    ) : (
      <ul className="m-0 grid max-h-[30vh] list-none grid-cols-3 gap-3 overflow-y-auto p-0">
        {list.map((s, i) => (
          <li key={s.id} className="min-w-0">
            <button type="button" aria-pressed={selected === s.id} onClick={() => setSelected(s.id)} className={pick}>
              <img src={s.thumbnail} alt="" className="aspect-video w-full rounded-control bg-surface-0 object-contain" />
              <span className="truncate text-caption text-ink">{label(s, i)}</span>
            </button>
          </li>
        ))}
      </ul>
    );

  return (
    <>
      <div className="flex flex-col gap-2">
        <span id="golive-source" className="text-small font-semibold text-ink-muted">
          {t("golive.source")}
        </span>
        <Segmented
          radiogroup
          labelledBy="golive-source"
          name="golive-tab"
          value={tab}
          onChange={(next) => (setTab(next), setSelected(null))}
          options={[
            { value: "apps", label: t("golive.tabApps") },
            { value: "screens", label: t("golive.tabScreens") },
            { value: "devices", label: t("golive.tabDevices") },
          ]}
        />
        {tab === "apps" && thumbs(windows, (s) => s.name, t("golive.noApps"))}
        {tab === "screens" && thumbs(screens, (_, i) => screenLabel(i), t("golive.noScreens"))}
        {tab === "devices" &&
          (devices.length === 0 ? (
            <p className="text-small text-ink-muted">{t("golive.noDevices")}</p>
          ) : (
            <ul className="m-0 flex max-h-[30vh] list-none flex-col gap-2 overflow-y-auto p-0">
              {devices.map((d) => (
                <li key={d.id}>
                  <button type="button" aria-pressed={selected === d.id} onClick={() => setSelected(d.id)} className={`${pick} flex-row items-center gap-3`}>
                    <VideoCamera aria-hidden="true" className="shrink-0" />
                    <span className="truncate text-small text-ink">{d.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </div>
      <div className="flex flex-col gap-2">
        <span id="golive-res" className="text-small font-semibold text-ink-muted">
          {t("golive.resolution")}
        </span>
        <Segmented radiogroup labelledBy="golive-res" name="golive-res" value={resolution} onChange={setResolution} options={RESOLUTIONS.map((r) => ({ value: r, label: r === "native" ? t("golive.native") : `${r}p` }))} />
        <span id="golive-fps" className="mt-1 text-small font-semibold text-ink-muted">
          {t("golive.fps")}
        </span>
        <Segmented radiogroup labelledBy="golive-fps" name="golive-fps" value={String(fps) as `${Fps}`} onChange={(v) => setFps(Number(v) as Fps)} options={FPS_CHOICES.map((f) => ({ value: String(f) as `${Fps}`, label: t("golive.fpsN", { n: String(f) }) }))} />
      </div>
      <Switch label={t("golive.audio")} description={canAudio ? undefined : tab === "devices" ? t("golive.audioDevice") : t("golive.audioOs")} checked={canAudio && audio} disabled={!canAudio} onChange={setAudio} />
      <DialogActions>
        <Button type="button" variant="ghost" onClick={screenPicker.cancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" disabled={!selected} onClick={confirm}>
          {t("golive.start")}
        </Button>
      </DialogActions>
    </>
  );
}
