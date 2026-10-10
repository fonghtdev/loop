/** Why an attachment failed (each has its own Vietnamese message). */
export type Failure = "network" | "storage" | "rejected" | "mismatch" | "tooMany" | "denied" | "unknown";

/**
 * picked -> validating (the server accepts the metadata) -> uploading(progress) -> completing (the server checks
 * the stored bytes) -> ready | failed. `removed` is final: late events from an abandoned upload change nothing.
 */
export type AttState =
  | { phase: "picked" }
  | { phase: "validating" }
  | { phase: "uploading"; progress: number }
  | { phase: "completing" }
  | { phase: "ready"; id: string }
  | { phase: "failed"; reason: Failure }
  | { phase: "removed" };

export type AttEvent =
  | { type: "validate" }
  | { type: "valid" }
  | { type: "progress"; value: number }
  | { type: "uploaded" }
  | { type: "done"; id: string }
  | { type: "fail"; reason: Failure }
  | { type: "retry" }
  | { type: "remove" };

const IN_FLIGHT: AttState["phase"][] = ["validating", "uploading", "completing"];

/** The next state; the same object when the event does not apply (so callers can skip a re-render). */
export function step(s: AttState, e: AttEvent): AttState {
  if (s.phase === "removed") return s;
  if (e.type === "remove") return { phase: "removed" };
  switch (e.type) {
    case "validate":
      return s.phase === "picked" ? { phase: "validating" } : s;
    case "valid":
      return s.phase === "validating" ? { phase: "uploading", progress: 0 } : s;
    case "progress":
      return s.phase === "uploading" ? { phase: "uploading", progress: Math.max(0, Math.min(1, e.value)) } : s;
    case "uploaded":
      return s.phase === "uploading" ? { phase: "completing" } : s;
    case "done":
      return s.phase === "completing" ? { phase: "ready", id: e.id } : s;
    case "fail":
      return IN_FLIGHT.includes(s.phase) ? { phase: "failed", reason: e.reason } : s;
    case "retry":
      return s.phase === "failed" ? { phase: "picked" } : s;
  }
}

/** Send needs every attachment ready: one still uploading or failed holds it back (failed ones: retry or remove). */
export const allReady = (states: AttState[]) => states.every((s) => s.phase === "ready");

/** The Send button: something to send (text or files), nothing in the way, and every file ready. */
export const canSend = (a: { disabled: boolean; over: boolean; textLength: number; files: AttState[] }) =>
  !a.disabled && !a.over && (a.textLength > 0 || a.files.length > 0) && allReady(a.files);
