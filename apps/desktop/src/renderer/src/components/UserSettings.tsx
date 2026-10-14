import { Gear, SignOut, Trash, X } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { BooleanSetting, Settings } from "../../../shared/settings";
import { acceleratorFromEvent, formatAccelerator, type ShortcutAction } from "../../../shared/shortcut";
import type { UpdateStatus } from "../../../shared/update";
import { t } from "../i18n/t";
import type { MessageKey } from "../i18n/vi";
import { appearance, MOTIONS, useAppearance, type Appearance } from "../lib/appearance";
import { density, DENSITIES, useDensity, type Density } from "../lib/density";
import { appSettings, devices, noiseLevel, session, sounds, unlockDeviceLabels } from "../lib/app";
import { DEVICE_KINDS, labelsAvailable, optionsFor, type DeviceKind } from "../lib/devices";
import { useNav } from "../lib/nav";
import { NOISE_LEVELS, type NoiseLevel } from "../lib/noise";
import { soundPrefs, useSoundPrefs } from "../lib/sound-prefs";
import { toast } from "../lib/toast";
import { Button } from "./Button";
import { Dialog, DialogActions } from "./Dialog";
import { Segmented } from "./Segmented";
import { Switch } from "./Switch";
import { Tooltip } from "./Tooltip";

/**
 * The user's own settings (main area, solid, nav place `settings: "user"`). Notification and system switches are
 * saved in the main process at once; each change round-trips and is confirmed by a toast (a polite live region).
 */
export function UserSettings() {
  const user = session.useSession((s) => s.user);
  const settings = useStore(appSettings.store, (s) => s.settings);
  const heading = useRef<HTMLHeadingElement>(null);
  const close = () => useNav.setState({ settings: null });

  useEffect(() => {
    heading.current?.focus();
    void appSettings.load(); // the tray can change a setting meanwhile
  }, []);

  const save = (key: BooleanSetting) => async (value: boolean) => {
    try {
      await appSettings.save({ [key]: value });
      toast.push(t("userSettings.saved"));
    } catch {
      toast.push(t("userSettings.saveFailed"), "error");
    }
  };

  return (
    <section aria-labelledby="user-settings-title" onKeyDown={(e) => e.key === "Escape" && close()} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-hair bg-head px-4 font-display text-[15px] font-bold shadow-[inset_0_1px_0_var(--color-highlight)]">
        <Gear aria-hidden="true" className="shrink-0 text-ink-muted" />
        <h1 id="user-settings-title" ref={heading} tabIndex={-1} className="min-w-0 flex-1 truncate outline-none">
          {t("userSettings.title")}
        </h1>
        <Tooltip label={t("settings.close")} kbd="Esc">
          <button type="button" onClick={close} aria-label={t("settings.close")} className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink active:scale-[.98]">
            <X aria-hidden="true" />
          </button>
        </Tooltip>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <Group id="notifications" title="userSettings.notifications">
            <Switch label={t("userSettings.notify")} description={t("userSettings.notifyHint")} checked={settings.notifications} onChange={save("notifications")} />
            <Switch label={t("userSettings.preview")} description={t("userSettings.previewHint")} checked={settings.preview} onChange={save("preview")} disabled={!settings.notifications} />
          </Group>
          <Group id="system" title="userSettings.system">
            <Switch label={t("userSettings.closeToTray")} description={t("userSettings.closeToTrayHint")} checked={settings.closeToTray} onChange={save("closeToTray")} />
            <Switch label={t("userSettings.startAtLogin")} description={t("userSettings.startAtLoginHint")} checked={settings.startAtLogin} onChange={save("startAtLogin")} />
          </Group>
          <Group id="looks" title="userSettings.looks">
            <LooksSection />
          </Group>
          <Group id="performance" title="userSettings.performance">
            <PerformanceSection />
          </Group>
          <Group id="update" title="userSettings.update">
            <UpdateSection />
          </Group>
          <Group id="sounds" title="userSettings.sounds">
            <SoundsSection />
          </Group>
          <Group id="shortcuts" title="userSettings.shortcuts">
            <ShortcutsSection settings={settings} />
          </Group>
          <Group id="media" title="userSettings.media">
            <DevicePickers />
          </Group>
          <Group id="account" title="userSettings.account">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-6 gap-y-2 px-3 py-2 text-[15px]">
              <dt className="text-ink-muted">{t("userSettings.username")}</dt>
              <dd className="min-w-0 truncate select-text">{user?.username}</dd>
              <dt className="text-ink-muted">{t("userSettings.email")}</dt>
              <dd className="min-w-0 truncate select-text">{user?.email}</dd>
            </dl>
            <div className="px-3 pb-2">
              <Button variant="ghost" onClick={() => void session.logout()} className="-ml-4">
                <SignOut aria-hidden="true" />
                {t("shell.logout")}
              </Button>
            </div>
          </Group>
          <Group id="uninstall" title="userSettings.uninstall">
            <UninstallSection />
          </Group>
        </div>
      </div>
    </section>
  );
}

/**
 * Removes the app and its data from THIS computer. The account stays on the server (said plainly in the dialog). The
 * real gate is the native dialog the main process shows (this page cannot click it); only after it does main revoke the
 * session on the server (best effort) and remove everything, so declining leaves the user signed in.
 */
function UninstallSection() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const proceed = async () => {
    setBusy(true);
    try {
      await window.loop.uninstall(); // main asks natively, then revokes the session itself; "cancelled" leaves everything as it was
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 px-3 py-2">
      <p className="text-[13px] leading-relaxed text-ink-muted">{t("userSettings.uninstallHint")}</p>
      <div>
        <Button variant="danger" onClick={() => setOpen(true)}>
          <Trash aria-hidden="true" />
          {t("userSettings.uninstallOpen")}
        </Button>
      </div>
      <Dialog open={open} onClose={() => !busy && setOpen(false)} title={t("userSettings.uninstallTitle")}>
        <div className="flex flex-col gap-3 text-[15px]">
          <div>
            <p className="font-medium">{t("userSettings.uninstallRemoved")}</p>
            <ul className="mt-1 list-disc pl-5 text-ink-muted">
              <li>{t("userSettings.uninstallRemovedApp")}</li>
              <li>{t("userSettings.uninstallRemovedData")}</li>
              <li>{t("userSettings.uninstallRemovedStartup")}</li>
            </ul>
          </div>
          <div>
            <p className="font-medium">{t("userSettings.uninstallKept")}</p>
            <p className="mt-1 text-ink-muted">{t("userSettings.uninstallKeptAccount")}</p>
          </div>
          <p className="text-[13px] text-ink-muted">{t("userSettings.uninstallNote")}</p>
        </div>
        <DialogActions>
          <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void proceed()}>
            {t("userSettings.uninstallConfirm")}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}

function Group({ id, title, children }: { id: string; title: MessageKey; children: ReactNode }) {
  return (
    <section aria-labelledby={`us-${id}`} className="relative edge rounded-panel bg-raise p-2 shadow-e2">
      <h2 id={`us-${id}`} className="px-3 pt-2 pb-1 font-display text-sm font-bold tracking-wide text-ink-muted uppercase">
        {t(title)}
      </h2>
      {children}
    </section>
  );
}

const MOTION_LABEL: Record<Appearance["motion"], MessageKey> = {
  system: "userSettings.motionSystem",
  reduced: "userSettings.motionReduced",
  full: "userSettings.motionFull",
};

const DENSITY_LABEL: Record<Density, MessageKey> = { comfy: "userSettings.densityComfy", compact: "userSettings.densityCompact" };

/** Per-ACCOUNT look: how tight the message list is. Applied at once, stored under the account's id (lib/density). */
function LooksSection() {
  const current = useDensity();
  return (
    <fieldset className="px-3 py-2">
      <legend className="text-[15px] font-medium">{t("userSettings.density")}</legend>
      <p className="mt-0.5 mb-2 text-[13px] leading-relaxed text-ink-muted">{t("userSettings.densityHint")}</p>
      <Segmented name="density" value={current} onChange={(d) => density.set(d)} options={DENSITIES.map((d) => ({ value: d, label: t(DENSITY_LABEL[d]) }))} />
    </fieldset>
  );
}

/** Per-device look: film grain on/off and how much the UI moves. Applied at once, stored in localStorage (lib/appearance). */
function PerformanceSection() {
  const a = useAppearance();
  return (
    <>
      <Switch label={t("userSettings.grain")} description={t("userSettings.grainHint")} checked={a.grain === "on"} onChange={(on) => appearance.set({ grain: on ? "on" : "off" })} />
      <fieldset className="px-3 py-2">
        <legend className="text-[15px] font-medium">{t("userSettings.motion")}</legend>
        <p className="mt-0.5 mb-2 text-[13px] leading-relaxed text-ink-muted">{t("userSettings.motionHint")}</p>
        <Segmented name="motion" value={a.motion} onChange={(m) => appearance.set({ motion: m })} options={MOTIONS.map((m) => ({ value: m, label: t(MOTION_LABEL[m]) }))} />
      </fieldset>
    </>
  );
}

/** Per-ACCOUNT voice-room sounds: on/off, volume, and a test of the join tone (lib/sound-prefs, lib/sounds). */
function SoundsSection() {
  const prefs = useSoundPrefs();
  const id = useId();
  return (
    <>
      <Switch label={t("userSettings.soundsToggle")} description={t("userSettings.soundsToggleHint")} checked={prefs.enabled} onChange={(enabled) => soundPrefs.set({ enabled })} />
      <div className="flex flex-col gap-1.5 px-3 py-2">
        <label htmlFor={id} className="text-[15px] font-medium">
          {t("userSettings.soundsVolume")}
        </label>
        <div className="flex items-center gap-3">
          <input id={id} type="range" min={0} max={100} step={5} value={prefs.volume} onChange={(e) => soundPrefs.set({ volume: Number(e.target.value) })} className="h-11 min-w-0 flex-1 accent-moss-400" />
          <span aria-hidden="true" className="w-10 shrink-0 text-right text-[13px] text-ink-muted tabular-nums">
            {prefs.volume}
          </span>
          <Button variant="ghost" onClick={() => (sounds.unlock(), sounds.preview())}>
            {t("userSettings.soundsTest")}
          </Button>
        </div>
      </div>
    </>
  );
}

const UPDATE_TEXT: Record<UpdateStatus["state"], MessageKey> = {
  disabled: "userSettings.updateDisabled",
  idle: "userSettings.updateIdle",
  checking: "userSettings.updateChecking",
  available: "userSettings.updateAvailable",
  downloading: "userSettings.updateDownloading",
  downloaded: "userSettings.updateDownloaded",
  error: "userSettings.updateError",
};

/** Current version, the updater's state (live region) and its two actions. The main process owns the state; this only shows it. */
function UpdateSection() {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    void window.loop.version().then(setVersion);
    void window.loop.update.get().then(setStatus);
    return window.loop.update.onStatus(setStatus);
  }, []);

  const state = status?.state;
  const text = state ? t(UPDATE_TEXT[state], { version: status?.version ?? "", error: status?.error ?? "" }) : "";
  return (
    <div className="flex flex-col gap-3 px-3 py-2">
      <p className="text-[15px]">
        <span className="text-ink-muted">{t("userSettings.version")} </span>
        <span className="select-text">{version}</span>
      </p>
      <p role="status" aria-live="polite" className={`min-h-5 text-[13px] leading-relaxed ${state === "error" ? "text-danger" : "text-ink-muted"}`}>
        {text}
      </p>
      {state && state !== "disabled" && (
        <div className="flex flex-wrap gap-2">
          {state === "downloaded" && <Button onClick={() => void window.loop.update.install()}>{t("userSettings.updateInstall")}</Button>}
          <Button variant="ghost" loading={state === "checking"} disabled={state !== "idle" && state !== "error"} onClick={() => void window.loop.update.check().then(setStatus)}>
            {t("userSettings.updateCheck")}
          </Button>
        </div>
      )}
    </div>
  );
}

const SHORTCUT_ROWS: { action: ShortcutAction; key: "micShortcut" | "deafenShortcut"; label: MessageKey }[] = [
  { action: "mic", key: "micShortcut", label: "userSettings.shortcutMic" },
  { action: "deafen", key: "deafenShortcut", label: "userSettings.shortcutDeafen" },
];

/** Two global shortcuts (the main process registers them). Click a box, press the keys; Esc / Backspace / Xoá clears. */
function ShortcutsSection({ settings }: { settings: Settings }) {
  const [listening, setListening] = useState<ShortcutAction | null>(null);
  const [failed, setFailed] = useState<ShortcutAction[]>([]);
  const [clash, setClash] = useState(false);
  const refreshFailed = () => void window.loop.failedShortcuts().then(setFailed, () => undefined);
  useEffect(refreshFailed, [settings.micShortcut, settings.deafenShortcut]);

  const assign = async (key: "micShortcut" | "deafenShortcut", value: string) => {
    const other = key === "micShortcut" ? settings.deafenShortcut : settings.micShortcut;
    setClash(!!value && value === other);
    if (value && value === other) return;
    try {
      await appSettings.save({ [key]: value });
    } catch {
      toast.push(t("userSettings.saveFailed"), "error");
    }
  };
  const onKeyDown = (key: "micShortcut" | "deafenShortcut") => (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation(); // Esc here clears the shortcut, it must not close the settings page
    const acc = e.key === "Escape" || e.key === "Backspace" ? "" : acceleratorFromEvent(e.nativeEvent, window.loop.platform);
    if (acc === null) return; // only modifiers so far
    setListening(null);
    void assign(key, acc);
  };

  return (
    <div className="flex flex-col gap-1 px-3 py-2">
      <p className="mb-1 text-[13px] leading-relaxed text-ink-muted">{t("userSettings.shortcutsHint")}</p>
      {SHORTCUT_ROWS.map(({ action, key, label }) => (
        <div key={action} className="flex items-center gap-2 py-1">
          <span className="min-w-0 flex-1 text-[15px] font-medium">{t(label)}</span>
          <button
            type="button"
            aria-label={t(label)}
            onClick={() => setListening(action)}
            onBlur={() => setListening((l) => (l === action ? null : l))}
            onKeyDown={listening === action ? onKeyDown(key) : undefined}
            className="h-11 min-w-36 rounded-control bg-surface-4 px-3 text-[14px] text-ink hover:bg-surface-3 aria-pressed:outline-2"
            aria-pressed={listening === action}
          >
            {listening === action ? t("userSettings.shortcutListening") : settings[key] ? formatAccelerator(settings[key], window.loop.platform) : t("userSettings.shortcutNone")}
          </button>
          <Button variant="ghost" disabled={!settings[key]} onClick={() => void assign(key, "")}>
            {t("userSettings.shortcutClear")}
          </Button>
        </div>
      ))}
      <p role="alert" className="min-h-5 text-[13px] text-danger">
        {clash ? t("userSettings.shortcutClash") : failed.length ? t("userSettings.shortcutTaken") : ""}
      </p>
    </div>
  );
}

const DEVICE_LABELS: Record<DeviceKind, MessageKey> = { audioinput: "userSettings.microphone", audiooutput: "userSettings.speaker", videoinput: "userSettings.camera" };

/** Microphone, speaker and camera selects. Names need media access, asked for when this opens (once the OS agrees). */
const NOISE_LABEL: Record<NoiseLevel, MessageKey> = { off: "userSettings.noiseOff", standard: "userSettings.noiseStandard", strong: "userSettings.noiseStrong" };

/** Microphone cleaning level (lib/noise); the live voice session follows at once. */
function NoiseLevelPicker() {
  const [level, setLevel] = useState(noiseLevel.get());
  return (
    <fieldset>
      <legend className="text-[15px] font-medium">{t("userSettings.noise")}</legend>
      <p className="mt-0.5 mb-2 text-[13px] leading-relaxed text-ink-muted">{t("userSettings.noiseHint")}</p>
      <Segmented
        name="noise"
        value={level}
        onChange={(l) => {
          noiseLevel.set(l);
          setLevel(l);
        }}
        options={NOISE_LEVELS.map((l) => ({ value: l, label: t(NOISE_LABEL[l]) }))}
      />
    </fieldset>
  );
}

function DevicePickers() {
  const { choices, devices: list } = useStore(devices.store);
  const [denied, setDenied] = useState(false);
  const named = labelsAvailable(list);

  useEffect(() => {
    void devices.refresh().then(() => unlockDeviceLabels()).then((ok) => setDenied(!ok));
  }, []);

  return (
    <div className="flex flex-col gap-4 px-3 py-2">
      {DEVICE_KINDS.map((kind) => {
        const options = optionsFor(list, kind, t(DEVICE_LABELS[kind]));
        const effective = devices.effective(kind) ?? "";
        const id = `device-${kind}`;
        return (
          <div key={kind} className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-[15px] font-medium">
              {t(DEVICE_LABELS[kind])}
            </label>
            <select
              id={id}
              value={options.some((o) => o.id === effective) ? effective : ""}
              onChange={(e) => {
                devices.choose(kind, e.target.value || null);
              }}
              className="h-11 w-full min-w-0 rounded-control border border-line-strong bg-surface-3 px-3 text-[15px] text-ink"
            >
              <option value="">{t("userSettings.systemDefault")}</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            {choices[kind] && effective === "" && <p className="text-[13px] text-warning">{t("userSettings.deviceGone")}</p>}
          </div>
        );
      })}
      <NoiseLevelPicker />
      {!named && (
        <p role="status" className="text-[13px] leading-relaxed text-ink-muted">
          {denied ? t("userSettings.noLabelsDenied") : t("userSettings.noLabels")}
        </p>
      )}
    </div>
  );
}
