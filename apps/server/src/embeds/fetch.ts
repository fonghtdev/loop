import { lookup } from "node:dns/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { pipeline, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { matchesType } from "../attachments/rules.js";

/**
 * THE ONLY place that makes outbound requests to user-supplied URLs (link previews). Threat: SSRF and resource
 * abuse. Every hop (first request and each redirect) goes through `checkUrl` (http/https, port 80/443, no
 * credentials, a real DNS name, no IP literal, no local-only names), then the name is resolved ONCE here and
 * EVERY address must be public; the connection then goes to that validated address (custom `lookup`), keeping
 * Host/SNI for the name, so a second DNS answer (rebinding) can never be used. Redirects are followed by hand
 * (at most 3), bodies are streamed under a byte cap counted AFTER decompression, and the whole fetch has a
 * deadline. Nothing from the user is forwarded: a fixed User-Agent, no cookies, no auth.
 */
export const LIMITS = {
  connectMs: 4_000,
  totalMs: 6_000,
  maxRedirects: 3,
  /** HTML is cut here (the <head> comes first), never failed for being long. */
  htmlBytes: 512 * 1024,
  /** A larger image is refused. */
  imageBytes: 2 * 1024 * 1024,
  headerBytes: 16 * 1024,
};
export const USER_AGENT = "LoopBot-Link-Preview/1.0";
const PORTS = new Set(["", "80", "443"]);
const PAGE_TYPES = new Set(["text/html", "application/xhtml+xml"]);
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
// Names that only mean something inside a network (or nothing at all).
const LOCAL_TLDS = new Set(["localhost", "local", "internal", "localdomain", "lan", "home", "corp", "intranet", "arpa", "test", "invalid", "onion"]);

// IPv4 that is not on the public internet (RFC 6890 special-purpose blocks).
const PRIVATE_V4 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata (169.254.169.254)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
] as const)
  PRIVATE_V4.addSubnet(net, bits, "ipv4");

const isPublicV4 = (a: string) => isIP(a) === 4 && !PRIVATE_V4.check(a, "ipv4");

/** Eight 16-bit groups, or null. Parsing through WHATWG URL also folds a dotted IPv4 tail into hex. */
function ipv6Groups(a: string): number[] | null {
  let host: string;
  try {
    host = new URL(`http://[${a}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const [head, tail] = host.split("::");
  const parse = (s: string | undefined) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const hi = parse(head);
  const lo = parse(tail);
  const groups = tail === undefined ? hi : [...hi, ...Array(8 - hi.length - lo.length).fill(0), ...lo];
  return groups.length === 8 ? groups : null;
}
const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Is this resolved address on the public internet? IPv6 is allow-listed (global unicast 2000::/3 only), so
 * loopback, unspecified, ULA fc00::/7, link-local fe80::/10, site-local, multicast are out by construction.
 * Forms that carry an IPv4 address (mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::/96, 6to4
 * 2002::/16) are judged by that IPv4. Teredo (2001::/32) is refused: its embedded client address is obfuscated.
 */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return isPublicV4(address);
  if (isIP(address) !== 6 || address.includes("%")) return false; // zone ids: link-local by definition
  const g = ipv6Groups(address);
  if (!g) return false;
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0 || g[5] === 0xffff)) return isPublicV4(v4Of(g[6]!, g[7]!));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicV4(v4Of(g[6]!, g[7]!));
  if (g[0] === 0x2002) return isPublicV4(v4Of(g[1]!, g[2]!));
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && (g[1]! < 0x200 || g[1] === 0xdb8)) return false; // special-purpose 2001::/23 (Teredo), documentation
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false; // documentation 3fff::/20
  return true;
}

/**
 * May this URL be requested at all (before any DNS)? WHATWG parsing already turns "2130706433", "0x7f.1",
 * "017700000001" and "127.1" into "127.0.0.1", so every numeric spelling lands in the IP-literal refusal.
 */
export function checkUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || !PORTS.has(u.port)) return null;
  const host = u.hostname.replace(/\.$/, "");
  if (!host || host.startsWith("[") || isIP(host)) return null; // IP literals: never (a real site has a name)
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => !l) || LOCAL_TLDS.has(labels[labels.length - 1]!) || /^\d+$/.test(labels[labels.length - 1]!)) return null;
  return u;
}

export type Resolved = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<Resolved[]>;
export type Response = { status: number; headers: IncomingHttpHeaders; body: Readable };
/** Opens one GET to `url` over a socket connected to `address` (never resolving the name again). */
export type Transport = (req: { url: URL; address: Resolved; headers: Record<string, string>; signal: AbortSignal; connectMs: number }) => Promise<Response>;

export const systemResolver: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** Node http(s) with the connection pinned to the validated address; Host and SNI stay the original name. */
export const pinnedTransport: Transport = ({ url, address, headers, signal, connectMs }) =>
  new Promise((resolve, reject) => {
    const secure = url.protocol === "https:";
    const req = (secure ? https : http).request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers,
      signal,
      agent: false, // no pooling, no global agent (and so no env proxy, which would resolve the name itself)
      maxHeaderSize: LIMITS.headerBytes,
      ...(secure && { servername: url.hostname }),
      lookup: ((_name, opts, cb) => (opts.all ? cb(null, [address]) : cb(null, address.address, address.family))) satisfies LookupFunction,
    });
    req.on("socket", (socket) => {
      const timer = setTimeout(() => req.destroy(new Error("connect timeout")), connectMs);
      socket.once("connect", () => clearTimeout(timer));
      socket.once("close", () => clearTimeout(timer));
    });
    req.on("response", (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }));
    req.on("error", reject);
    req.end();
  });

const mediaType = (h: string | undefined) => (h ?? "").split(";")[0]!.trim().toLowerCase();
const charsetOf = (h: string | undefined) => /charset\s*=\s*"?([\w-]+)/i.exec(h ?? "")?.[1];

/** The body, decompressed if it says so; null for an encoding we cannot bound. */
function decoded(body: Readable, encoding: string | undefined): Readable | null {
  const make = { "": null, identity: null, gzip: createGunzip, "x-gzip": createGunzip, deflate: createInflate, br: createBrotliDecompress }[(encoding ?? "").trim().toLowerCase()];
  if (make === undefined) return null;
  if (make === null) return body;
  const out = make();
  pipeline(body, out, () => {});
  return out;
}

/** Reads at most `cap` bytes; `cut` keeps what came (HTML), otherwise going over is a failure (images). */
async function readCapped(stream: Readable, cap: number, cut: boolean): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > cap) {
        if (!cut) return null;
        chunks.push(chunk.subarray(0, chunk.length - (size - cap)));
        return Buffer.concat(chunks);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    stream.destroy(); // stops the download (and the inflater) once we have enough
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const KINDS = {
  page: { accept: "text/html,application/xhtml+xml;q=0.9", types: PAGE_TYPES, cap: () => LIMITS.htmlBytes, cut: true },
  image: { accept: "image/png,image/jpeg,image/gif,image/webp", types: IMAGE_TYPES, cap: () => LIMITS.imageBytes, cut: false },
};

export type Fetched = { url: string; type: string; charset?: string; bytes: Buffer };
export type FetcherDeps = { resolve?: Resolver; transport?: Transport; limits?: Partial<typeof LIMITS> };

/** `get(url, kind)`: the final body, or null for ANY refusal or failure (never throws). */
export function createFetcher({ resolve = systemResolver, transport = pinnedTransport, limits = {} }: FetcherDeps = {}) {
  const lim = { ...LIMITS, ...limits };
  const until = <T>(p: Promise<T>, signal: AbortSignal) =>
    Promise.race([p, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true }))]);

  async function get(start: string, kind: keyof typeof KINDS): Promise<Fetched | null> {
    const k = KINDS[kind];
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), lim.totalMs);
    const { signal } = deadline;
    try {
      let next = start;
      for (let hop = 0; ; hop++) {
        const url = checkUrl(next);
        if (!url) return null;
        const addresses = await until(resolve(url.hostname.replace(/\.$/, "")), signal);
        if (!addresses.length || !addresses.every((a) => isPublicAddress(a.address))) return null; // one bad answer taints the name
        const headers = { "user-agent": USER_AGENT, accept: k.accept, "accept-encoding": "gzip, deflate, br", connection: "close" };
        const res = await until(transport({ url, address: addresses[0]!, headers, signal, connectMs: lim.connectMs }), signal);
        if (REDIRECTS.has(res.status)) {
          res.body.destroy();
          const location = res.headers.location;
          if (!location || hop >= lim.maxRedirects) return null;
          next = new URL(location, url).href; // checked like the first URL at the top of the loop
          continue;
        }
        const type = mediaType(res.headers["content-type"]);
        const declared = Number(res.headers["content-length"] ?? 0);
        const body = res.status === 200 && k.types.has(type) && !(declared > k.cap() && !k.cut) ? decoded(res.body, res.headers["content-encoding"]) : null;
        if (!body) {
          res.body.destroy();
          return null;
        }
        const bytes = await until(readCapped(body, kind === "page" ? lim.htmlBytes : lim.imageBytes, k.cut), signal);
        return bytes && { url: url.href, type, charset: charsetOf(res.headers["content-type"]), bytes };
      }
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      deadline.abort(); // ends any socket still open (a body we stopped reading, a request past its deadline)
    }
  }

  return {
    /** An HTML page as text (cut at the HTML cap), with the URL it finally came from. */
    async page(url: string) {
      const r = await get(url, "page");
      if (!r) return null;
      let decoder: TextDecoder;
      try {
        decoder = new TextDecoder(r.charset ?? "utf-8");
      } catch {
        decoder = new TextDecoder("utf-8");
      }
      return { url: r.url, html: decoder.decode(r.bytes) };
    },
    /** An image whose bytes really are the declared png/jpeg/gif/webp. */
    async image(url: string) {
      const r = await get(url, "image");
      return r && matchesType(r.type, r.bytes) ? { contentType: r.type, bytes: r.bytes } : null;
    },
  };
}
export type Fetcher = ReturnType<typeof createFetcher>;
