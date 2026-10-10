import { Gear, SignOut, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { Settings } from "../../../shared/settings";
import type { UpdateStatus } from "../../../shared/update";
import { t } from "../i18n/t";
import type { MessageKey } from "../i18n/vi";
import { appSettings, devices, session, unlockDeviceLabels } from "../lib/app";
import { DEVICE_KINDS, labelsAvailable, optionsFor, type DeviceKind } from "../lib/devices";
import { useNav } from "../lib/nav";
import { Button } from "./Button";
import { Switch } from "./Switch";

/**
 * The user's own settings (main area, solid, nav place `settings: "user"`). Notification and system switches are
 * saved in the main process at once; each change round-trips and is confirmed in a polite live region.
 */
export function UserSettings() {
  const user = session.useSession((s) => s.user);
  const settings = useStore(appSettings.store, (s) => s.settings);
  const [status, setStatus] = useState<"saved" | "failed" | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const close = () => useNav.setState({ settings: null });

  useEffect(() => {
    heading.current?.focus();
    void appSettings.load(); // the tray can change a setting meanwhile
  }, []);

  const save = (key: keyof Settings) => async (value: boolean) => {
    try {
      await appSettings.save({ [key]: value });
      setStatus("saved");
    } catch {
      setStatus("failed");
    }
  };

  return (
    <section aria-labelledby="user-settings-title" onKeyDown={(e) => e.key === "Escape" && close()} className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 font-display text-[15px] font-bold">
        <Gear aria-hidden="true" className="shrink-0 text-ink-muted" />
        <h1 id="user-settings-title" ref={heading} tabIndex={-1} className="min-w-0 flex-1 truncate outline-none">
          {t("userSettings.title")}
        </h1>
        <button type="button" onClick={close} aria-label={t("settings.close")} title={t("settings.close")} className="grid size-10 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-surface-4 hover:text-ink">
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <p role="status" aria-live="polite" className={`min-h-5 text-sm ${status === "failed" ? "text-danger" : "text-moss-300"}`}>
            {status === "saved" && t("userSettings.saved")}
            {status === "failed" && t("userSettings.saveFailed")}
          </p>
          <Group id="notifications" title="userSettings.notifications">
            <Switch label={t("userSettings.notify")} description={t("userSettings.notifyHint")} checked={settings.notifications} onChange={save("notifications")} />
            <Switch label={t("userSettings.preview")} description={t("userSettings.previewHint")} checked={settings.preview} onChange={save("preview")} disabled={!settings.notifications} />
          </Group>
          <Group id="system" title="userSettings.system">
            <Switch label={t("userSettings.closeToTray")} description={t("userSettings.closeToTrayHint")} checked={settings.closeToTray} onChange={save("closeToTray")} />
            <Switch label={t("userSettings.startAtLogin")} description={t("userSettings.startAtLoginHint")} checked={settings.startAtLogin} onChange={save("startAtLogin")} />
          </Group>
          <Group id="update" title="userSettings.update">
            <UpdateSection />
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
        </div>
      </div>
    </section>
  );
}

function Group({ id, title, children }: { id: string; title: MessageKey; children: ReactNode }) {
  return (
    <section aria-labelledby={`us-${id}`} className="rounded-panel border border-line bg-surface-1 p-2">
      <h2 id={`us-${id}`} className="px-3 pt-2 pb-1 font-display text-sm font-bold tracking-wide text-ink-muted uppercase">
        {t(title)}
      </h2>
      {children}
    </section>
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

const DEVICE_LABELS: Record<DeviceKind, MessageKey> = { audioinput: "userSettings.microphone", audiooutput: "userSettings.speaker", videoinput: "userSettings.camera" };

/** Microphone, speaker and camera selects. Names need media access, asked for when this opens (once the OS agrees). */
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
      {!named && (
        <p role="status" className="text-[13px] leading-relaxed text-ink-muted">
          {denied ? t("userSettings.noLabelsDenied") : t("userSettings.noLabels")}
        </p>
      )}
    </div>
  );
}
