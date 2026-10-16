export const PREFIX = "!";
export const MAX_QUERY_LENGTH = 200;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

/** `!Play  some song` -> { name: "play", args: "some song" }; anything that is not a command -> null. */
export function parseCommand(content: string) {
  const m = new RegExp(`^${PREFIX}(\\S+)(?:\\s+([\\s\\S]*))?$`).exec(content.trim());
  return m ? { name: m[1]!.toLowerCase(), args: (m[2] ?? "").replace(/\s+/g, " ").trim() } : null;
}

export type Kind = "youtube" | "soundcloud" | "url";
export type Query = { url: string; source: Kind } | { search: string; only?: "soundcloud" };

const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"]);
// The bot's host fetches these pages, so keep it off the host's own network: no IP literals, no single-label or internal names, no credentials
const INTERNAL_HOST = /^\d+(\.\d+){3}$|^\[|(^|\.)(localhost|local|internal|lan)$|^[^.]+$/i;

/**
 * A link is played as is (one video, never the playlist): YouTube and SoundCloud by host, any other public http(s) link as "url" for yt-dlp to try.
 * `sc <text>` searches SoundCloud only; everything else is a search (YouTube first, see `MUSIC_SOURCES`).
 */
export function classify(query: string): Query {
  try {
    const u = new URL(query);
    if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && !INTERNAL_HOST.test(u.hostname))
      return { url: u.href, source: YOUTUBE_HOSTS.has(u.hostname) ? "youtube" : SOUNDCLOUD_HOSTS.has(u.hostname) ? "soundcloud" : "url" };
  } catch {
    // not a URL: a search
  }
  const sc = /^sc\s+(\S[\s\S]*)$/i.exec(query);
  return sc ? { search: sc[1]!, only: "soundcloud" } : { search: query };
}
