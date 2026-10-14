export type ScreenSource = { id: string; name: string; thumbnail: string };
type Captured = { id: string; name: string; thumbnail: { toDataURL(): string } };

/** The options of a `choose`: exactly `{ audio: boolean }`. */
function parseAudio(opts: unknown): boolean {
  const o = opts as { audio?: unknown } | null;
  if (typeof o !== "object" || o === null || Array.isArray(o) || Object.keys(o).length !== 1 || typeof o.audio !== "boolean") throw new Error("invalid screen options");
  return o.audio;
}

/**
 * Screen sharing, main side. The renderer lists the screens and windows (with thumbnails), the user picks one in
 * the app's own dialog, and `choose` remembers it (and whether the sound was asked for) for exactly one
 * `getDisplayMedia`: `handler` (installed with setDisplayMediaRequestHandler) answers a request from our own page
 * with that source, and refuses everything else (no pick, a second request, another origin). System audio needs both
 * the request and Windows (Electron's `loopback`); elsewhere the share simply has no sound.
 */
export function createScreenShare({
  getSources,
  trusted,
  platform,
}: {
  getSources: (o: { types: ("screen" | "window")[]; thumbnailSize: { width: number; height: number }; fetchWindowIcons: boolean }) => Promise<Captured[]>;
  trusted: (url: string) => boolean;
  platform: string;
}) {
  let listed: Captured[] = [];
  let chosen: { source: Captured; audio: boolean } | null = null;
  return {
    async list(): Promise<ScreenSource[]> {
      listed = await getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false });
      return listed.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
    },
    choose(id: unknown, opts: unknown) {
      const source = typeof id === "string" ? listed.find((s) => s.id === id) : undefined;
      if (!source) throw new Error("unknown screen source");
      chosen = { source, audio: parseAudio(opts) };
    },
    handler(request: { frame?: { url: string } | null }, callback: (streams: { video?: Captured; audio?: "loopback" }) => void) {
      const pick = chosen;
      chosen = null;
      if (!pick || !trusted(request.frame?.url ?? "")) return callback({});
      callback({ video: pick.source, ...(pick.audio && platform === "win32" ? { audio: "loopback" as const } : {}) });
    },
  };
}
