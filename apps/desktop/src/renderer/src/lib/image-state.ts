/**
 * An inline image whose presigned URL may have expired (they last 1 hour). One failed load fetches a fresh URL
 * ONCE and retries; a second failure stops at "failed" (the user's Retry button is the only way on). No loops.
 */
export type ImgState = { phase: "loading" | "refreshing" | "ok" | "failed"; src: string; refreshed: boolean };
export type ImgEvent = { type: "loaded" } | { type: "error" } | { type: "fresh"; url: string } | { type: "freshFailed" } | { type: "retry" };

export const initialImage = (src: string): ImgState => ({ phase: "loading", src, refreshed: false });

export function imageStep(s: ImgState, e: ImgEvent): ImgState {
  switch (e.type) {
    case "loaded":
      return s.phase === "loading" ? { ...s, phase: "ok" } : s;
    case "error":
      if (s.phase !== "loading" && s.phase !== "ok") return s;
      return s.refreshed ? { ...s, phase: "failed" } : { ...s, phase: "refreshing", refreshed: true };
    case "fresh":
      return s.phase === "refreshing" ? { ...s, phase: "loading", src: e.url } : s;
    case "freshFailed":
      return s.phase === "refreshing" ? { ...s, phase: "failed" } : s;
    case "retry":
      return s.phase === "failed" ? { ...s, phase: "refreshing", refreshed: true } : s;
  }
}
