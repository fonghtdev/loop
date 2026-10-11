import { CaretDown, Check, Gear, Headphones, Microphone, MicrophoneSlash, SignOut } from "@phosphor-icons/react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { devices, session, unlockDeviceLabels, voice } from "../lib/app";
import { labelsAvailable, optionsFor, type DeviceKind } from "../lib/devices";
import { useNav } from "../lib/nav";
import { isActive } from "../lib/voice-hooks";
import { Avatar } from "./Avatar";
import { MenuItem, RowMenu } from "./RowMenu";
import { Control } from "./VoiceBar";
import { HeadphonesSlash } from "./VoiceIndicators";

/** The input or output devices to pick from; the current one is marked. Names need media access, asked for when this opens. */
function DeviceMenu({ id, kind, label }: { id: string; kind: Extract<DeviceKind, "audioinput" | "audiooutput">; label: string }) {
  const list = useStore(devices.store, (s) => s.devices);
  const named = labelsAvailable(list);
  const effective = devices.effective(kind) ?? "";
  const heading = t(kind === "audioinput" ? "userSettings.microphone" : "userSettings.speaker");
  const options = [{ id: "", label: t("userSettings.systemDefault") }, ...optionsFor(list, kind, heading)];
  const open = () => void devices.refresh().then(() => (labelsAvailable(devices.store.getState().devices) ? undefined : unlockDeviceLabels()));
  return (
    <RowMenu id={id} label={label} align="left" width="w-72" size="h-10 w-5" onOpen={open} trigger={<CaretDown aria-hidden="true" size={14} weight="bold" />}>
      {(close) => (
        <>
          <p className="px-2.5 pt-1 pb-1.5 text-caption font-semibold text-ink-muted">{heading}</p>
          {options.map((o) => (
            <MenuItem
              key={o.id}
              icon={<Check aria-hidden="true" className={o.id === effective ? "" : "invisible"} />}
              label={o.label}
              selected={o.id === effective}
              onClick={() => {
                devices.choose(kind, o.id || null);
                close();
              }}
            />
          ))}
          {!named && <p className="px-2.5 py-1.5 text-caption text-ink-muted">{t("userSettings.noLabels")}</p>}
        </>
      )}
    </RowMenu>
  );
}

/** Always visible: who you are, mute / deafen with their device menus, and settings. Logout is in the name's menu. */
export function AccountStrip() {
  const user = session.useSession((s) => s.user);
  const v = useStore(voice.store);
  const inCall = isActive(v.status);
  const ready = v.status === "connected";
  const micHint = !inCall ? t("voice.needsCall") : !v.canSpeak ? t("voice.micNoSpeak") : v.deafened ? t("voice.micDeafened") : t("voice.mic");

  return (
    <section aria-label={t("shell.account")} className="flex items-center px-1.5 py-2">
      <RowMenu
        id="account"
        label={t("shell.accountMenu")}
        align="left"
        width="w-64"
        size="h-12 min-w-0 flex-1 px-1"
        className="text-left !text-ink"
        trigger={
          <span className="flex w-full min-w-0 items-center gap-2">
            <span className="relative shrink-0">
              <Avatar id={user?.id ?? ""} name={user?.username ?? ""} className="size-8 rounded-full text-xs ring-2 ring-presence-on/60" />
              <span aria-hidden="true" className="absolute -right-0.5 -bottom-0.5 size-3 rounded-full bg-presence-on ring-2 ring-surface-3" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui leading-tight font-semibold">{user?.username}</span>
              <span className="block truncate text-caption leading-tight text-ink-muted">{t("presence.online")}</span>
            </span>
          </span>
        }
      >
        {(close) => (
          <>
            <p className="truncate px-2.5 pt-1 pb-1.5 text-caption text-ink-muted">{user?.email}</p>
            <MenuItem
              icon={<SignOut aria-hidden="true" />}
              label={t("shell.logout")}
              danger
              onClick={() => {
                close();
                void session.logout();
              }}
            />
          </>
        )}
      </RowMenu>
      <Control label={t("voice.mic")} hint={micHint} pressed={inCall && !v.micEnabled} disabled={!ready || !v.canSpeak || v.deafened} onClick={() => void voice.toggleMic()}>
        {inCall && !v.micEnabled ? <MicrophoneSlash aria-hidden="true" /> : <Microphone aria-hidden="true" />}
      </Control>
      <DeviceMenu id="mic-devices" kind="audioinput" label={t("voice.mic.devices")} />
      <Control label={t("voice.deafen")} hint={inCall ? t("voice.deafen") : t("voice.needsCall")} pressed={v.deafened} disabled={!ready} onClick={() => void voice.toggleDeafen()}>
        {v.deafened ? <HeadphonesSlash aria-hidden="true" /> : <Headphones aria-hidden="true" />}
      </Control>
      <DeviceMenu id="speaker-devices" kind="audiooutput" label={t("voice.speaker.devices")} />
      <Control label={t("userSettings.open")} hint={t("userSettings.open")} onClick={() => useNav.setState({ settings: "user" })}>
        <Gear aria-hidden="true" />
      </Control>
    </section>
  );
}
