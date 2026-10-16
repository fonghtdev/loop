import { Phone, VideoCamera } from "@phosphor-icons/react";
import { useStore } from "zustand";
import { t } from "../i18n/t";
import { calls, voice } from "../lib/app";
import { useDisplayName } from "../lib/identity-hooks";
import { isActive } from "../lib/voice-hooks";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { Dialog } from "./Dialog";

/** The caller's avatar with three rings spreading out of it (CSS, transform + opacity; still under reduced motion). */
export function RippleAvatar({ id, name, className = "size-24 text-3xl" }: { id: string; name: string; className?: string }) {
  return (
    <span aria-hidden="true" className="relative mx-auto my-4 grid shrink-0 place-items-center">
      {[0, 1, 2].map((i) => (
        <span key={i} data-ripple style={{ animationDelay: `${i * 0.8}s` }} className="absolute inset-0 animate-ripple rounded-full border-2 border-cosmic-300 opacity-0" />
      ))}
      <Avatar id={id} name={name} className={`relative rounded-full ${className}`} />
    </span>
  );
}

/**
 * The incoming-call dialog (native <dialog>, glass like every dialog): focus lands on Answer, Esc declines.
 * It never switches the current session by itself; answering is what leaves it.
 */
export function IncomingCall() {
  const incoming = useStore(calls.store, (s) => s.incoming);
  const busy = useStore(voice.store, (s) => isActive(s.status));
  const name = useDisplayName(incoming?.from.id ?? "", incoming?.from.username ?? "");
  const Kind = incoming?.video ? VideoCamera : Phone;
  return (
    <Dialog
      open={!!incoming}
      onClose={() => void calls.decline()}
      title={incoming?.video ? t("call.incomingVideo", { name }) : t("call.incomingVoice", { name })}
      hero={incoming && <RippleAvatar id={incoming.from.id} name={name} />}
    >
      <p className="-mt-2 inline-flex items-center justify-center gap-1.5 text-small text-ink-muted">
        <Kind aria-hidden="true" />
        {incoming?.video ? t("call.kindVideo") : t("call.kindVoice")}
      </p>
      {busy && <p className="text-small leading-relaxed text-ink-muted">{t("call.incomingBusy")}</p>}
      <div className="mt-2 grid grid-cols-2 gap-3">
        <Button type="button" variant="danger" className="h-13!" onClick={() => void calls.decline()}>
          {t("call.decline")}
        </Button>
        {/* the native autofocus attribute is what showModal() honours (React's autoFocus focuses before the dialog opens) */}
        <Button type="button" className="h-13!" ref={(el) => el?.setAttribute("autofocus", "")} onClick={() => void calls.accept()}>
          {t("call.accept")}
        </Button>
      </div>
    </Dialog>
  );
}
