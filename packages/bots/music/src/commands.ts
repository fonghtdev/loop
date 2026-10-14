export const PREFIX = "!";
export const MAX_QUERY_LENGTH = 200;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

/** `!Play  some song` -> { name: "play", args: "some song" }; anything that is not a command -> null. */
export function parseCommand(content: string) {
  const m = new RegExp(`^${PREFIX}(\\S+)(?:\\s+([\\s\\S]*))?$`).exec(content.trim());
  return m ? { name: m[1]!.toLowerCase(), args: (m[2] ?? "").replace(/\s+/g, " ").trim() } : null;
}

/** A YouTube link on a known host is played as is (one video, never the playlist); everything else is a search. */
export function classify(query: string): { url: string } | { search: string } {
  try {
    const u = new URL(query);
    if ((u.protocol === "https:" || u.protocol === "http:") && YOUTUBE_HOSTS.has(u.hostname)) return { url: u.href };
  } catch {
    // not a URL: a search
  }
  return { search: query };
}
