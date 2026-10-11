import { animate, createTimeline, spring, stagger, type AnimationParams } from "animejs";
import { useSyncExternalStore } from "react";
import { appearance, isReducedMotion } from "./appearance";

/**
 * The only door to anime.js in the app. Rules (Spec "Danh mục chuyển động"): everything moves through `animate`
 * here so that (a) reduced motion jumps to the end state, (b) durations stay in budget, (c) only transform and
 * opacity animate. Continuously changing values (audio level) go through CSS variables, not through here.
 */
export const BUDGET = { uiMin: 120, uiMax: 260, entranceMax: 600, sequenceMax: 900, staggerMax: 500 } as const;

export type Kind = "ui" | "entrance";
type Params = Record<string, unknown>;

const TRANSFORM_PROPS = new Set(["opacity", "x", "y", "z", "scale", "scaleX", "scaleY", "rotate", "translateX", "translateY", "skewX", "skewY"]);
const CONTROL_KEYS = new Set(["duration", "delay", "ease", "loop", "alternate", "reversed", "autoplay", "composition", "onBegin", "onUpdate", "onComplete", "onLoop"]);

export const clampDuration = (ms: number, kind: Kind = "ui") => Math.min(Math.max(ms, BUDGET.uiMin), kind === "entrance" ? BUDGET.entranceMax : BUDGET.uiMax);

/** The end value of a tween spec: [from, to] -> to, { from, to } -> to, a plain value stays. */
const endState = (v: unknown): unknown => (Array.isArray(v) ? v[v.length - 1] : v && typeof v === "object" && "to" in v ? (v as { to: unknown }).to : v);

/**
 * Turns the caller's params into what may run: unknown (layout) properties are dropped with a warning unless named
 * in `allow`, durations are clamped, and under reduced motion every property jumps to its end state in 1 ms.
 */
export function budgeted(params: Params, opts: { reduced: boolean; kind?: Kind; allow?: string[] }): Params {
  const out: Params = {};
  for (const [key, value] of Object.entries(params)) {
    if (CONTROL_KEYS.has(key)) {
      out[key] = value;
    } else if (TRANSFORM_PROPS.has(key) || opts.allow?.includes(key)) {
      const spec = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Params) : null;
      out[key] = opts.reduced ? endState(value) : spec && typeof spec.duration === "number" ? { ...spec, duration: clampDuration(spec.duration, opts.kind) } : value;
    } else {
      console.warn(`motion: "${key}" is not a transform/opacity property, skipped (pass it in allow to override)`);
    }
  }
  if (opts.reduced) return { ...out, duration: 1, delay: 0, ease: "linear" };
  if (typeof out.duration === "number") out.duration = clampDuration(out.duration, opts.kind);
  return out;
}

/** Per-item delay so that `count` items start within the stagger budget and the sequence ends within the ceiling. */
export function staggerStep(count: number, step = 24, duration = 220) {
  const room = Math.min(BUDGET.staggerMax, BUDGET.sequenceMax - duration);
  return Math.max(0, Math.min(step, Math.floor(room / Math.max(1, count - 1))));
}

const systemReduced = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
/** Right now, for code that animates inside an event handler. */
export const reducedNow = () => isReducedMotion(appearance.get().motion, systemReduced());

export function move(targets: Parameters<typeof animate>[0], params: Params, opts: { kind?: Kind; allow?: string[] } = {}) {
  return animate(targets, budgeted(params, { reduced: reducedNow(), ...opts }) as AnimationParams);
}

/** A timeline whose steps go through the same budget. */
export function timeline(opts: { kind?: Kind } = {}) {
  const tl = createTimeline();
  const add = tl.add.bind(tl) as (targets: unknown, params: Params, position?: unknown) => typeof tl;
  tl.add = ((targets: unknown, params: Params, position?: unknown) => add(targets, budgeted(params, { reduced: reducedNow(), ...opts }), position)) as typeof tl.add;
  return tl;
}

export { spring, stagger };

const subscribeReduced = (cb: () => void) => {
  const mq = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
  mq?.addEventListener("change", cb);
  const off = appearance.subscribe(cb);
  return () => {
    mq?.removeEventListener("change", cb);
    off();
  };
};
/** True when motion should be skipped: the OS setting combined with the in-app choice. */
export const useReducedMotion = () => useSyncExternalStore(subscribeReduced, reducedNow);
