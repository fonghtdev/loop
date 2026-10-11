/** What decides whether a new message row slides in (see `shouldAnimateArrival`). */
export type ArrivalContext = {
  /** Came in through the socket as a new message (not a history page, not a catch-up, not our own send). */
  live: boolean;
  /** The list is pinned to the bottom, so the row appears inside the viewport. */
  nearViewport: boolean;
  /** The first page has rendered and no older page is loading. */
  settled: boolean;
  reducedMotion: boolean;
};

/** Only a live arrival, in view, in a settled list, with motion allowed. One row at a time, never history. */
export const shouldAnimateArrival = (c: ArrivalContext) => c.live && c.nearViewport && c.settled && !c.reducedMotion;
