import { spawn, type ChildProcess } from "node:child_process";
import { classify } from "./commands.js";

export const MAX_DURATION_SECONDS = 3600 * 3;
// A tiny host (Render free: 0.1 CPU) needs minutes for one yt-dlp lookup (measured: 38 s just to start, ~3 min for a search); 30 s killed it silently.
export const META_TIMEOUT_MS = 300_000;
const MAX_TITLE = 80;

export type Track = { id: string; title: string; duration: number };

/** An error whose message is meant for the person who typed the command. */
export class UserError extends Error {}

export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/** Metadata of one video: a link as is, a search as `ytsearch1:`; the target comes after `--`, so it can never be an option. */
export function metaArgs(query: string) {
  const c = classify(query);
  return ["--dump-single-json", "--no-playlist", "--playlist-items", "1", "--skip-download", "--no-warnings", "--", "url" in c ? c.url : `ytsearch1:${c.search}`];
}
export const audioArgs = (id: string) => ["-f", "bestaudio/best", "-o", "-", "--no-playlist", "--no-warnings", "--", watchUrl(id)];
export const FFMPEG_ARGS = ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ar", "48000", "-ac", "1", "pipe:1"];

const oneLine = (s: string) => s.replace(/[\p{Cc}\s]+/gu, " ").trim();
const clip = (s: string) => (s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE - 1)}…` : s);

/** What yt-dlp said on stderr, as a sentence for the user. */
function logFailure(stderr: string, how: string) {
  console.error("[music] yt-dlp:", how, stderr.trim().slice(-500)); // the user gets a short sentence; the host's log gets the real reason
}
function explain(stderr: string, how = "") {
  logFailure(stderr, how);
  return /unavailable|private|removed|sign in|confirm your age|copyright|blocked/i.test(stderr) ? "Video không khả dụng." : "Không tìm thấy hoặc không tải được video.";
}

/** From yt-dlp's JSON (a search answers with a playlist of one) to a Track, or why it cannot be played. */
export function toTrack(json: any): Track {
  const info = json?.entries ? json.entries[0] : json;
  if (!info) throw new UserError("Không tìm thấy kết quả.");
  if (info.is_live || typeof info.duration !== "number") throw new UserError("Không phát được live stream.");
  if (info.duration > MAX_DURATION_SECONDS) throw new UserError(`Video dài quá (tối đa ${MAX_DURATION_SECONDS / 3600} giờ).`);
  if (!/^[\w-]{11}$/.test(info.id ?? "")) throw new UserError("Chỉ phát video YouTube.");
  return { id: info.id, title: clip(oneLine(String(info.title ?? "")) || "(không tên)"), duration: info.duration };
}

/** yt-dlp finds the video, yt-dlp | ffmpeg turn it into PCM. `spawnFn` is a seam for tests. */
export function createSource({ ytdlp = "yt-dlp", ffmpeg = "ffmpeg", spawnFn = spawn }: { ytdlp?: string; ffmpeg?: string; spawnFn?: typeof spawn } = {}) {
  function resolve(query: string) {
    return new Promise<Track>((done, fail) => {
      const child = spawnFn(ytdlp, metaArgs(query), { stdio: ["ignore", "pipe", "pipe"], timeout: META_TIMEOUT_MS });
      let out = "";
      let err = "";
      child.stdout!.on("data", (d) => (out += d));
      child.stderr!.on("data", (d) => (err += d));
      child.on("error", () => fail(new UserError(`Không chạy được ${ytdlp} (đã cài chưa?).`)));
      child.on("close", (code, signal) => {
        if (signal) {
          logFailure(err, `killed by ${signal} after the ${META_TIMEOUT_MS / 1000} s limit`);
          return fail(new UserError("yt-dlp quá chậm, thử lại sau."));
        }
        if (code !== 0) return fail(new UserError(explain(err, `exit ${code}`)));
        try {
          done(toTrack(JSON.parse(out)));
        } catch (e) {
          fail(e instanceof UserError ? e : new UserError("Không đọc được kết quả từ yt-dlp."));
        }
      });
    });
  }

  async function* open(track: Track, signal: AbortSignal): AsyncGenerator<Buffer> {
    const dl: ChildProcess = spawnFn(ytdlp, audioArgs(track.id), { stdio: ["ignore", "pipe", "pipe"] });
    const ff: ChildProcess = spawnFn(ffmpeg, FFMPEG_ARGS, { stdio: ["pipe", "pipe", "ignore"] });
    const kill = () => {
      dl.kill();
      ff.kill();
    };
    signal.addEventListener("abort", kill);
    let err = "";
    let spawnFailed = false;
    dl.stderr!.on("data", (d) => (err = (err + d).slice(-2000)));
    for (const child of [dl, ff]) child.on("error", () => ((spawnFailed = true), kill()));
    ff.stdin!.on("error", () => {}); // ffmpeg went away first
    dl.stdout!.pipe(ff.stdin!);
    let got = false;
    try {
      for await (const chunk of ff.stdout!) {
        got = true;
        yield chunk as Buffer;
      }
      if (signal.aborted || got) return;
      throw new UserError(spawnFailed ? `Không chạy được ${ytdlp}/${ffmpeg} (đã cài chưa?).` : explain(err));
    } finally {
      signal.removeEventListener("abort", kill);
      kill();
    }
  }

  return { resolve, open };
}
