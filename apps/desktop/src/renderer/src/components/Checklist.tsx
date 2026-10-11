import { Check } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../i18n/t";
import type { MessageKey } from "../i18n/vi";
import { firstRun } from "../lib/app";
import { completionWatcher, doneCount, shouldShow, STEPS, type Step } from "../lib/firstrun";
import { useFirstRun } from "../lib/firstrun-hooks";
import { move, useReducedMotion } from "../lib/motion";
import { Button } from "./Button";

const LABELS: Record<Step, MessageKey> = {
  server: "firstRun.step.server",
  friend: "firstRun.step.friend",
  message: "firstRun.step.message",
  voice: "firstRun.step.voice",
};
const CIRCLE = 81.7; // 2 * pi * r (r = 13 in a 32 box)
const CELEBRATE_MS = 2200;

/** The "Bắt đầu" card on Home: shown while a step is open and not hidden (lib/firstrun.ts), with a short thank-you at the end. */
export function Checklist() {
  const run = useFirstRun();
  const reduced = useReducedMotion();
  const [celebrating, setCelebrating] = useState(false);
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const watcher = useRef<ReturnType<typeof completionWatcher>>(undefined);
  watcher.current ??= completionWatcher(() => !reducedRef.current && setCelebrating(true));

  const done = run?.done;
  useEffect(() => {
    if (done) watcher.current?.(done);
  }, [done]);
  useEffect(() => {
    if (!celebrating) return;
    const id = setTimeout(() => setCelebrating(false), CELEBRATE_MS);
    return () => clearTimeout(id);
  }, [celebrating]);

  if (!run || (!celebrating && !shouldShow(run.done, run.saved))) return null;
  return <Card done={run.done} celebrating={celebrating} />;
}

function Card({ done, celebrating }: { done: Record<Step, boolean>; celebrating: boolean }) {
  const count = doneCount(done);
  const ring = useRef<SVGCircleElement>(null);
  const was = useRef(count);
  const offset = CIRCLE * (1 - count / STEPS.length);
  // the ring runs from the old fill to the new one (a jump under reduced motion, see lib/motion.ts)
  useLayoutEffect(() => {
    if (was.current !== count && ring.current) move(ring.current, { strokeDashoffset: [CIRCLE * (1 - was.current / STEPS.length), offset], duration: 400, ease: "outQuart" }, { allow: ["strokeDashoffset"] });
    was.current = count;
  }, [count, offset]);

  return (
    <section aria-labelledby="checklist-title" className="relative animate-rise rounded-panel bg-surface-1 p-5 shadow-e1">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 id="checklist-title" className="font-display text-title font-extrabold tracking-[-0.015em]">
          {t("firstRun.title")}
        </h2>
        <div className="flex items-center gap-3 text-small text-ink-muted">
          <span className="numeric">{t("firstRun.progress", { done: String(count), total: String(STEPS.length) })}</span>
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className="size-8 -rotate-90">
            <circle cx="16" cy="16" r="13" strokeWidth="3" className="stroke-surface-4" />
            <circle ref={ring} cx="16" cy="16" r="13" strokeWidth="3" strokeLinecap="round" strokeDasharray={CIRCLE} strokeDashoffset={offset} className="stroke-moss-300" />
          </svg>
          <Button variant="ghost" onClick={() => firstRun.dismiss()} className="px-2 text-caption">
            {t("firstRun.hide")}
          </Button>
        </div>
      </header>
      {celebrating ? (
        <p role="status" className="animate-fade rounded-control bg-moss-900 px-4 py-3 text-moss-200">
          {t("firstRun.celebrate")}
        </p>
      ) : (
        <ol aria-label={t("firstRun.list")} className="flex flex-col">
          {STEPS.map((step) => (
            <li key={step} className="flex min-h-11 items-center gap-3 rounded-control px-2">
              <span
                aria-hidden="true"
                className={`grid size-[22px] shrink-0 place-items-center rounded-full border-2 transition-colors duration-(--duration-base) ${done[step] ? "border-moss-400 bg-moss-400 text-on-moss" : "border-line-strong text-transparent"}`}
              >
                <Check size={14} weight="bold" />
              </span>
              <span className={done[step] ? "text-ink-faint line-through decoration-ink-faint/50" : "text-ink"}>{t(LABELS[step])}</span>
              <span className="sr-only">{t(done[step] ? "firstRun.stepDone" : "firstRun.stepOpen")}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
