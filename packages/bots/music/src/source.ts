import { spawn, type ChildProcess } from "node:child_process";
import { TtlLru } from "./cache.js";
import { classify, type Kind } from "./commands.js";

export const MAX_DURATION_SECONDS = 3600 * 3;
// A tiny host (Render free: 0.1 CPU) needs minutes for one yt-dlp lookup (measured: 38 s just to start, ~3 min for a search); 30 s killed it silently.
export const META_TIMEOUT_MS = 300_000;
/** A stream URL that yt-dlp resolved is used for this long; after that (or when ffmpeg cannot read it) yt-dlp is asked again. */
export const DIRECT_TTL_MS = 20 * 60_000;
const MAX_TITLE = 80;
const NOTHING_FOUND = "Không tìm thấy kết quả.";

export type Direct = { url: string; headers: Record<string, string>; at: number };
/** `page` is what yt-dlp can be asked about again; `direct` is the short-lived stream URL (never cached). */
export type Track = { id: string; title: string; duration: number; source: Kind; page: string; direct?: Direct };

/** An error whose message is meant for the person who typed the command. */
export class UserError extends Error {}
/** A yt-dlp run that failed; `failure` tells the caller whether another source is worth trying. */
export class LookupError extends UserError {
  constructor(
    message: string,
    readonly failure: Failure,
  ) {
    super(message);
  }
}

const LABEL: Record<Kind, string> = { youtube: "YouTube", soundcloud: "SoundCloud", url: "link" };
const SEARCH_PREFIX = { youtube: "ytsearch1", soundcloud: "scsearch1" } as const;
export type SearchSource = keyof typeof SEARCH_PREFIX;

/** Suffix for messages: nothing for the default source, so only a fallback or a link is called out. */
export const sourceTag = (t: Track) => (t.source !== "youtube" && LABEL[t.source] ? ` (${LABEL[t.source]})` : "");

/** `MUSIC_SOURCES=soundcloud,youtube` -> the order searches try; unknown names are dropped, nothing valid means both in the default order. */
export function parseSources(env?: string): SearchSource[] {
  const list = (env ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s): s is SearchSource => s in SEARCH_PREFIX);
  return list.length ? [...new Set(list)] : ["youtube", "soundcloud"];
}

export type Failure = "blocked" | "unavailable" | "other";
/** What yt-dlp's stderr means: `blocked` = this host is refused (bot check, 403/429, rate limit), so another source may work; `unavailable` = this one video is not playable. */
export function classifyFailure(stderr: string): Failure {
  if (/not a bot|sign in to confirm (?!your age)|HTTP Error (403|429)|too many requests|rate-limited|captcha/i.test(stderr)) return "blocked";
  return /unavailable|private|removed|sign in|confirm your age|copyright|blocked/i.test(stderr) ? "unavailable" : "other";
}

const cookieArgs = (cookies?: string) => (cookies ? ["--cookies", cookies] : []);
// One yt-dlp run answers everything: the page URL, the title and the stream URL. The target comes after `--`, so it can never be an option.
const FIELDS = "%(.{id,title,duration,is_live,webpage_url,url,http_headers,protocol})j";
export function metaArgs(target: string, source: Kind, { cookies, ytClient }: { cookies?: string; ytClient?: string } = {}) {
  const youtube = source === "youtube";
  return [
    ...(youtube ? cookieArgs(cookies) : []), // a cookie file holds YouTube's cookies; other sites do not need them
    ...(youtube && ytClient ? ["--extractor-args", `youtube:player_client=${ytClient}`] : []),
    "-f", "bestaudio/best", "--print", FIELDS, "--no-playlist", "--playlist-items", "1", "--no-warnings", "--no-update", "--", target,
  ];
}
export const audioArgs = (page: string, source: Kind, cookies?: string) => [...(source === "youtube" ? cookieArgs(cookies) : []), "-f", "bestaudio/best", "-o", "-", "--no-playlist", "--no-warnings", "--no-update", "--", page];

const headerBlock = (h: Record<string, string>) => Object.entries(h).map(([k, v]) => `${k}: ${v}`.replace(/[\r\n]+/g, " ") + "\r\n").join("");
const OUT = ["-f", "s16le", "-ar", "48000", "-ac", "1", "pipe:1"];
/** ffmpeg reads yt-dlp's piped download, or (when yt-dlp already resolved it) the stream URL itself with the headers yt-dlp says it needs. */
export function ffmpegArgs(direct?: Direct) {
  const base = ["-hide_banner", "-loglevel", "error"];
  if (!direct) return [...base, "-i", "pipe:0", ...OUT];
  const reconnect = /\.m3u8(\?|$)/.test(direct.url) ? [] : ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"];
  return [...base, "-nostdin", ...reconnect, "-headers", headerBlock(direct.headers), "-i", direct.url, ...OUT];
}

const oneLine = (s: string) => s.replace(/[\p{Cc}\s]+/gu, " ").trim();
const clip = (s: string) => (s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE - 1)}…` : s);

function logFailure(stderr: string, how: string) {
  console.error("[music] yt-dlp:", how, stderr.trim().slice(-500)); // the user gets a short sentence; the host's log gets the real reason
}
/** What yt-dlp said on stderr, as a sentence for the user. */
function explain(stderr: string, source: Kind, how = "") {
  logFailure(stderr, how);
  const failure = classifyFailure(stderr);
  // YouTube refuses data-centre addresses ("Sign in to confirm you're not a bot"): not the video's fault, and only cookies (or another source) help
  if (failure === "blocked") return new LookupError(`${LABEL[source]} đang chặn máy chủ của bot${source === "youtube" ? " (cần cookie đăng nhập, xem docs/DEPLOY.md)" : ""}.`, failure);
  return new LookupError(failure === "unavailable" ? "Video không khả dụng." : "Không tìm thấy hoặc không tải được video.", failure);
}

const STREAM_PROTOCOLS = new Set(["https", "http", "m3u8_native", "m3u8"]);
/** From yt-dlp's JSON (a search answers with a playlist of one) to a Track, or why it cannot be played. */
export function toTrack(json: any, source: Kind, link?: string): Track {
  const info = json?.entries ? json.entries[0] : json;
  if (!info) throw new UserError(NOTHING_FOUND);
  const known = source !== "url"; // a plain link may be a file without a duration
  if (info.is_live || (known && typeof info.duration !== "number")) throw new UserError("Không phát được live stream.");
  const duration = typeof info.duration === "number" ? info.duration : 0;
  if (duration > MAX_DURATION_SECONDS) throw new UserError(`Video dài quá (tối đa ${MAX_DURATION_SECONDS / 3600} giờ).`);
  const id = String(info.id ?? "");
  if (source === "youtube" && !/^[\w-]{11}$/.test(id)) throw new UserError("Chỉ phát video YouTube.");
  const page = source === "youtube" ? `https://www.youtube.com/watch?v=${id}` : String(info.webpage_url ?? link ?? "");
  if (!/^https?:\/\//.test(page)) throw new UserError("Không đọc được kết quả từ yt-dlp.");
  const track: Track = { id, title: clip(oneLine(String(info.title ?? "")) || "(không tên)"), duration, source, page };
  const url = String(info.url ?? "");
  if (/^https?:\/\//.test(url) && STREAM_PROTOCOLS.has(info.protocol)) track.direct = { url, headers: info.http_headers ?? {}, at: Date.now() };
  return track;
}

export type SourceOptions = { ytdlp?: string; ffmpeg?: string; cookies?: string; ytClient?: string; sources?: SearchSource[]; spawnFn?: typeof spawn; cache?: TtlLru<Track> };
const fresh = (d?: Direct): d is Direct => !!d && Date.now() - d.at < DIRECT_TTL_MS;

/** yt-dlp finds the track (and its stream URL in the same run), ffmpeg turns it into PCM. `spawnFn` is a seam for tests. */
export function createSource({ ytdlp = "yt-dlp", ffmpeg = "ffmpeg", cookies, ytClient, sources = parseSources(), spawnFn = spawn, cache = new TtlLru<Track>() }: SourceOptions = {}) {
  /** One yt-dlp run; `signal` kills it (a background lookup that is no longer wanted). */
  function lookup(target: string, source: Kind, signal?: AbortSignal) {
    return new Promise<Track>((done, fail) => {
      const child = spawnFn(ytdlp, metaArgs(target, source, { cookies, ytClient }), { stdio: ["ignore", "pipe", "pipe"], timeout: META_TIMEOUT_MS });
      const stop = () => child.kill();
      signal?.addEventListener("abort", stop);
      let out = "";
      let err = "";
      child.stdout!.on("data", (d) => (out += d));
      child.stderr!.on("data", (d) => (err += d));
      child.on("error", () => fail(new UserError(`Không chạy được ${ytdlp} (đã cài chưa?).`)));
      child.on("close", (code, killedBy) => {
        signal?.removeEventListener("abort", stop);
        if (signal?.aborted) return fail(new UserError("Đã huỷ."));
        if (killedBy) {
          logFailure(err, `killed by ${killedBy} after the ${META_TIMEOUT_MS / 1000} s limit`);
          return fail(new UserError("yt-dlp quá chậm, thử lại sau."));
        }
        if (code !== 0) return fail(explain(err, source, `exit ${code}`));
        try {
          done(toTrack(JSON.parse(out.trim().split("\n").pop()!), source, source === "url" ? target : undefined));
        } catch (e) {
          fail(e instanceof UserError ? e : new UserError("Không đọc được kết quả từ yt-dlp."));
        }
      });
    });
  }

  /**
   * A link as is; a search through the configured sources in order. A source that refuses this host (or finds nothing) hands over to the next one,
   * and `notify` says so. Search results (not stream URLs, they expire) are remembered for replays.
   */
  async function resolve(query: string, notify: (text: string) => void = () => {}): Promise<Track> {
    const q = classify(query);
    if ("url" in q) return lookup(q.url, q.source);
    const order: SearchSource[] = q.only ? [q.only] : sources;
    const key = `${q.only ?? "*"}|${q.search.trim().toLowerCase().replace(/\s+/g, " ")}`;
    const hit = cache.get(key);
    if (hit) return { ...hit };
    const failures: LookupError[] = [];
    for (const [i, src] of order.entries()) {
      try {
        const track = await lookup(`${SEARCH_PREFIX[src]}:${q.search}`, src);
        cache.set(key, { ...track, direct: undefined });
        return track;
      } catch (e) {
        const empty = e instanceof UserError && e.message === NOTHING_FOUND;
        if (!empty && !(e instanceof LookupError && e.failure === "blocked")) throw e; // only a refused host or an empty answer makes another source worth trying
        failures.push(e instanceof LookupError ? e : new LookupError(NOTHING_FOUND, "other"));
        const next = order[i + 1];
        if (next) notify(failures.at(-1)!.failure === "blocked" ? `${LABEL[src]} chặn máy chủ, đang thử ${LABEL[next]}...` : `Không thấy trên ${LABEL[src]}, đang thử ${LABEL[next]}...`);
      }
    }
    if (failures.length === 1) throw failures[0]!;
    const labels = order.map((s) => LABEL[s]).join(", ");
    throw new UserError(failures.every((f) => f.failure === "blocked") ? `Các nguồn (${labels}) đều chặn máy chủ của bot.` : `Không tìm thấy bài nào (đã thử: ${labels}).`);
  }

  /** Resolves the stream URL ahead of time (a cached or queued track has only its page), so starting the track needs no yt-dlp run. Errors are not worth reporting: playing falls back to yt-dlp. */
  async function prefetch(track: Track, signal: AbortSignal) {
    if (fresh(track.direct)) return;
    const found = await lookup(track.page, track.source, signal);
    if (!signal.aborted) track.direct = found.direct;
  }

  async function* open(track: Track, signal: AbortSignal): AsyncGenerator<Buffer> {
    if (fresh(track.direct)) {
      try {
        let got = false;
        for await (const chunk of convert(signal, ffmpegArgs(track.direct))) {
          got = true;
          yield chunk;
        }
        if (got || signal.aborted) return;
      } catch (e) {
        if (signal.aborted) return;
        console.error("[music] direct stream failed, asking yt-dlp instead:", (e as Error).message);
      }
      track.direct = undefined;
    }
    yield* convert(signal, ffmpegArgs(), audioArgs(track.page, track.source, cookies), track.source);
  }

  /** ffmpeg's PCM; with `dlArgs` yt-dlp's download is piped into it. Kills both when `signal` aborts or the consumer stops reading. */
  async function* convert(signal: AbortSignal, ffArgs: string[], dlArgs?: string[], source: Kind = "youtube"): AsyncGenerator<Buffer> {
    const dl: ChildProcess | undefined = dlArgs && spawnFn(ytdlp, dlArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const ff: ChildProcess = spawnFn(ffmpeg, ffArgs, { stdio: ["pipe", "pipe", "pipe"] });
    const kill = () => {
      dl?.kill();
      ff.kill();
    };
    signal.addEventListener("abort", kill);
    let err = "";
    let spawnFailed = false;
    const collect = (d: Buffer) => (err = (err + d).slice(-2000));
    (dl ?? ff).stderr!.on("data", collect);
    for (const child of [dl, ff]) child?.on("error", () => ((spawnFailed = true), kill()));
    ff.stdin!.on("error", () => {}); // ffmpeg went away first
    if (dl) dl.stdout!.pipe(ff.stdin!);
    try {
      let got = false;
      for await (const chunk of ff.stdout!) {
        got = true;
        yield chunk as Buffer;
      }
      if (signal.aborted || got) return;
      throw spawnFailed ? new UserError(`Không chạy được ${ytdlp}/${ffmpeg} (đã cài chưa?).`) : dl ? explain(err, source) : new Error(err.trim() || "no audio");
    } finally {
      signal.removeEventListener("abort", kill);
      kill();
    }
  }

  return { resolve, prefetch, open };
}
