import { Phone, VideoCamera } from "@phosphor-icons/react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { calls, voice } from "../lib/app";
import { isActive } from "../lib/voice-hooks";
import { Button } from "./Button";
import { Dialog, DialogActions } from "./Dialog";

/**
 * The incoming-call dialog (native <dialog>, glass like every dialog): focus lands on Answer, Esc declines.
 * It never switches the current session by itself; answering is what leaves it.
 */
export function IncomingCall() {
  const incoming = useStore(calls.store, (s) => s.incoming);
  const busy = useStore(voice.store, (s) => isActive(s.status));
  const name = incoming?.from.username ?? "";
  return (
    <Dialog open={!!incoming} onClose={() => void calls.decline()} title={incoming?.video ? t("call.incomingVideo", { name }) : t("call.incomingVoice", { name })}>
      <span aria-hidden="true" className="grid size-12 animate-pulse place-items-center rounded-full bg-moss-900 text-moss-200">
        {incoming?.video ? <VideoCamera size={24} /> : <Phone size={24} />}
      </span>
      {busy && <p className="text-sm leading-relaxed text-ink-muted">{t("call.incomingBusy")}</p>}
      <DialogActions>
        <Button type="button" variant="ghost" onClick={() => void calls.decline()}>
          {t("call.decline")}
        </Button>
        {/* the native autofocus attribute is what showModal() honours (React's autoFocus focuses before the dialog opens) */}
        <Button type="button" ref={(el) => el?.setAttribute("autofocus", "")} onClick={() => void calls.accept()}>
          {t("call.accept")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
