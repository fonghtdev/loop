import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkUrl, createFetcher, isPublicAddress, LIMITS, pinnedTransport, type Resolved, type Transport, USER_AGENT } from "./fetch.js";

// No network anywhere in this file except a local server for the pinned transport itself.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PUBLIC = "93.184.216.34";
const html = (s = "<title>Hi</title>") => Buffer.from(`<html><head>${s}</head></html>`);

type Page = { status?: number; headers?: Record<string, string>; body?: Buffer | Readable };
/** A fake internet: names -> answers (a list per call, for rebinding), URLs -> responses. Records every connection. */
function fakeWeb(dns: Record<string, string[] | string[][]>, pages: Record<string, Page>) {
  const calls: { url: string; address: string; headers: Record<string, string> }[] = [];
  const lookups: string[] = [];
  const count = new Map<string, number>();
  const resolve = async (host: string): Promise<Resolved[]> => {
    lookups.push(host);
    const answer = dns[host];
    if (!answer) throw new Error("ENOTFOUND");
    const n = count.get(host) ?? 0;
    count.set(host, n + 1);
    const list = (Array.isArray(answer[0]) ? (answer as string[][])[Math.min(n, answer.length - 1)] : answer) as string[];
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const transport: Transport = async ({ url, address, headers }) => {
    calls.push({ url: url.href, address: address.address, headers });
    const p = pages[url.href] ?? { status: 404 };
    const body = p.body instanceof Readable ? p.body : Readable.from([p.body ?? Buffer.alloc(0)]);
    return { status: p.status ?? 200, headers: { "content-type": "text/html; charset=utf-8", ...p.headers }, body };
  };
  return { fetcher: (limits = {}) => createFetcher({ resolve, transport, limits }), calls, lookups };
}
const redirect = (to: string, status = 302): Page => ({ status, headers: { location: to } });

describe("checkUrl (before any DNS)", () => {
  it.each([
    "https://example.com/",
    "http://example.com:80/a?b=c",
    "https://sub.example.org:443/",
    "https://example.com:80/", // only ports 80 and 443, whatever the scheme
    "https://xn--bcher-kva.example/",
  ])("allows %s", (url) => expect(checkUrl(url)).not.toBeNull());

  it.each([
    ["ftp://example.com/", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["gopher://example.com/", "scheme"],
    ["https://example.com:8080/", "port 8080"],
    ["http://example.com:8443/", "port"],
    ["http://example.com:22/", "port"],
    ["http://user:pass@example.com/", "credentials"],
    ["http://user@example.com/", "username"],
    ["http://127.0.0.1/", "IPv4 literal"],
    ["http://8.8.8.8/", "public IP literal too"],
    ["http://2130706433/", "decimal IPv4"],
    ["http://0x7f.1/", "hex IPv4"],
    ["http://017700000001/", "octal IPv4"],
    ["http://127.1/", "short IPv4"],
    ["http://0177.0.0.1/", "octal dotted"],
    ["http://[::1]/", "IPv6 literal"],
    ["http://[::ffff:127.0.0.1]/", "mapped literal"],
    ["http://169.254.169.254/latest/meta-data/", "metadata"],
    ["http://localhost/", "localhost"],
    ["http://localhost./", "localhost with a dot"],
    ["http://api.localhost/", "*.localhost"],
    ["http://printer.local/", ".local"],
    ["http://db.internal/", ".internal"],
    ["http://router.lan/", ".lan"],
    ["http://x.home.arpa/", "home.arpa"],
    ["http://1.0.0.127.in-addr.arpa/", "reverse zone"],
    ["http://intranet/", "single label"],
    ["http://a..b.example/", "empty label"],
    ["not a url", "junk"],
  ])("refuses %s (%s)", (url) => expect(checkUrl(url)).toBeNull());
});

describe("isPublicAddress (every resolved address is judged)", () => {
  it.each([
    "8.8.8.8", "1.1.1.1", PUBLIC, "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0",
    "192.167.255.255", "192.169.0.0", "169.253.255.255", "223.255.255.255",
    "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:80b::200e",
    "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2002:808:808::1",
  ])("public: %s", (a) => expect(isPublicAddress(a)).toBe(true));

  it.each([
    ["0.0.0.0", "this network"], ["0.1.2.3", "0/8"],
    ["10.0.0.1", "private 10/8"], ["10.255.255.255", "private 10/8"],
    ["100.64.0.1", "CGNAT"], ["100.127.255.255", "CGNAT"],
    ["127.0.0.1", "loopback"], ["127.255.255.254", "loopback"],
    ["169.254.169.254", "cloud metadata"], ["169.254.0.1", "link-local"],
    ["172.16.0.1", "private 172.16/12"], ["172.31.255.255", "private 172.16/12"],
    ["192.168.1.1", "private 192.168/16"],
    ["192.0.0.8", "IETF"], ["192.0.2.1", "TEST-NET-1"], ["198.51.100.1", "TEST-NET-2"], ["203.0.113.1", "TEST-NET-3"],
    ["192.88.99.1", "6to4 relay"], ["198.18.0.1", "benchmark"], ["198.19.255.255", "benchmark"],
    ["224.0.0.1", "multicast"], ["239.255.255.250", "multicast"],
    ["240.0.0.1", "reserved"], ["255.255.255.255", "broadcast"],
    ["::", "unspecified"], ["::1", "IPv6 loopback"],
    ["fc00::1", "ULA"], ["fd12:3456::1", "ULA"],
    ["fe80::1", "link-local"], ["fe80::1%en0", "zone id"], ["febf::1", "link-local top"], ["fec0::1", "site-local"],
    ["ff02::1", "multicast"], ["100::1", "discard"],
    ["::ffff:127.0.0.1", "mapped loopback"], ["::ffff:7f00:1", "mapped loopback, hex"], ["::ffff:10.0.0.1", "mapped private"],
    ["::ffff:169.254.169.254", "mapped metadata"], ["::127.0.0.1", "compatible loopback"], ["::a00:1", "compatible private"],
    ["64:ff9b::7f00:1", "NAT64 loopback"], ["64:ff9b::a9fe:a9fe", "NAT64 metadata"], ["64:ff9b:1::1", "local NAT64"],
    ["2002:7f00:1::1", "6to4 loopback"], ["2002:a00:1::", "6to4 private"], ["2002:a9fe:a9fe::", "6to4 metadata"],
    ["2001::1", "Teredo"], ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "Teredo"],
    ["2001:db8::1", "documentation"], ["3fff::1", "documentation"], ["2001:10::1", "ORCHID"],
    ["not-an-ip", "junk"], ["", "empty"], ["1.2.3", "short"],
  ])("refused: %s (%s)", (a) => expect(isPublicAddress(a)).toBe(false));
});

describe("createFetcher", () => {
  it("uses the agreed limits", () => {
    expect(LIMITS).toEqual({ connectMs: 4000, totalMs: 6000, maxRedirects: 3, htmlBytes: 512 * 1024, imageBytes: 2 * 1024 * 1024, headerBytes: 16 * 1024 });
  });

  it("fetches a page from the validated address with fixed, polite headers only", async () => {
    const web = fakeWeb({ "site.example": [PUBLIC] }, { "https://site.example/": { body: html() } });
    const page = await web.fetcher().page("https://site.example/");
    expect(page).toEqual({ url: "https://site.example/", html: "<html><head><title>Hi</title></head></html>" });
    expect(web.calls).toHaveLength(1);
    expect(web.calls[0]!.address).toBe(PUBLIC);
    expect(web.calls[0]!.headers["user-agent"]).toBe(USER_AGENT);
    expect(Object.keys(web.calls[0]!.headers).sort()).toEqual(["accept", "accept-encoding", "connection", "user-agent"]);
  });

  it.each([
    [["10.0.0.1"], "private"],
    [[PUBLIC, "127.0.0.1"], "one private answer among public ones"],
    [["::1"], "IPv6 loopback"],
    [["::ffff:169.254.169.254"], "mapped metadata"],
    [[], "no answer"],
  ])("never connects when the name resolves to %j (%s)", async (answer) => {
    const web = fakeWeb({ "evil.example": answer }, { "https://evil.example/": { body: html() } });
    expect(await web.fetcher().page("https://evil.example/")).toBeNull();
    expect(web.calls).toEqual([]);
  });

  it("an unknown name is a quiet failure", async () => {
    const web = fakeWeb({}, {});
    expect(await web.fetcher().page("https://nowhere.example/")).toBeNull();
  });

  it("DNS rebinding: resolves once per hop and connects to that answer; a later private answer is refused", async () => {
    // first answer public, every later answer private (the classic rebind)
    const web = fakeWeb({ "rebind.example": [[PUBLIC], ["127.0.0.1"]] }, {
      "https://rebind.example/": redirect("https://rebind.example/again"),
      "https://rebind.example/again": { body: html() },
    });
    expect(await web.fetcher().page("https://rebind.example/")).toBeNull();
    expect(web.calls.map((c) => c.address)).toEqual([PUBLIC]); // the private answer was never connected to
    expect(web.lookups).toEqual(["rebind.example", "rebind.example"]);
  });

  it.each([
    ["https://internal.example/", "a name that resolves privately"],
    ["http://127.0.0.1/", "an IP literal"],
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://localhost/", "localhost"],
    ["http://site.example:8080/", "port 8080"],
    ["http://user:pw@site.example/", "credentials"],
    ["ftp://site.example/", "another scheme"],
    ["//[::1]/", "a scheme-relative IPv6 literal"],
  ])("a redirect to %s (%s) is refused", async (to) => {
    const web = fakeWeb({ "site.example": [PUBLIC], "internal.example": ["10.1.2.3"] }, {
      "https://site.example/": redirect(to),
      [new URL(to, "https://site.example/").href]: { body: html() },
    });
    expect(await web.fetcher().page("https://site.example/")).toBeNull();
    expect(web.calls).toHaveLength(1);
  });

  it("follows up to 3 redirects (relative ones too), and reports where it landed", async () => {
    const web = fakeWeb({ "a.example": [PUBLIC], "b.example": [PUBLIC] }, {
      "https://a.example/": redirect("/1", 301),
      "https://a.example/1": redirect("https://b.example/2", 307),
      "https://b.example/2": redirect("3", 308),
      "https://b.example/3": { body: html() },
    });
    expect((await web.fetcher().page("https://a.example/"))?.url).toBe("https://b.example/3");
  });

  it("gives up after the third redirect, and on a loop", async () => {
    const chain = fakeWeb({ "a.example": [PUBLIC] }, {
      "https://a.example/": redirect("/1"),
      "https://a.example/1": redirect("/2"),
      "https://a.example/2": redirect("/3"),
      "https://a.example/3": redirect("/4"),
      "https://a.example/4": { body: html() },
    });
    expect(await chain.fetcher().page("https://a.example/")).toBeNull();
    expect(chain.calls).toHaveLength(4);
    const loop = fakeWeb({ "a.example": [PUBLIC] }, { "https://a.example/": redirect("/x"), "https://a.example/x": redirect("/") });
    expect(await loop.fetcher().page("https://a.example/")).toBeNull();
    expect(loop.calls).toHaveLength(4);
  });

  it.each([
    [{ status: 302 }, "a redirect without Location"],
    [{ status: 404, body: html() }, "404"],
    [{ status: 500, body: html() }, "500"],
    [{ headers: { "content-type": "application/json" }, body: Buffer.from("{}") }, "JSON"],
    [{ headers: { "content-type": "image/svg+xml" }, body: html() }, "SVG"],
    [{ headers: { "content-type": "" }, body: html() }, "no type"],
    [{ headers: { "content-encoding": "compress" }, body: html() }, "an encoding it cannot bound"],
  ])("refuses %j (%s)", async (page) => {
    const web = fakeWeb({ "site.example": [PUBLIC] }, { "https://site.example/": page as Page });
    expect(await web.fetcher().page("https://site.example/")).toBeNull();
  });

  it("cuts a long page at the HTML cap and stops reading", async () => {
    let produced = 0;
    const endless = new Readable({
      read() {
        produced += 64 * 1024;
        this.push(Buffer.alloc(64 * 1024, "a"));
      },
    });
    const web = fakeWeb({ "site.example": [PUBLIC] }, { "https://site.example/": { body: endless } });
    const page = await web.fetcher().page("https://site.example/");
    expect(page!.html.length).toBe(LIMITS.htmlBytes);
    expect(produced).toBeLessThan(LIMITS.htmlBytes * 2);
    expect(endless.destroyed).toBe(true);
  });

  it("decompression bomb: the cap counts decompressed bytes", async () => {
    const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024)); // ~50 KB on the wire, 50 MB inflated
    expect(bomb.length).toBeLessThan(LIMITS.htmlBytes);
    const web = fakeWeb({ "site.example": [PUBLIC] }, {
      "https://site.example/page": { headers: { "content-encoding": "gzip" }, body: bomb },
      "https://site.example/img": { headers: { "content-encoding": "gzip", "content-type": "image/png" }, body: gzipSync(Buffer.concat([PNG, Buffer.alloc(50 * 1024 * 1024)])) },
    });
    const started = Date.now();
    expect((await web.fetcher().page("https://site.example/page"))!.html.length).toBe(LIMITS.htmlBytes);
    expect(await web.fetcher().image("https://site.example/img")).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000); // stopped inflating early (50 MB would take far longer)
  });

  it("a gzip page within the cap is read whole", async () => {
    const web = fakeWeb({ "site.example": [PUBLIC] }, { "https://site.example/": { headers: { "content-encoding": "gzip" }, body: gzipSync(html()) } });
    expect((await web.fetcher().page("https://site.example/"))?.html).toContain("<title>Hi</title>");
  });

  it("a body that never ends, or a resolver that never answers, fails at the deadline", async () => {
    const stuck = new Readable({ read() {} });
    const web = fakeWeb({ "site.example": [PUBLIC] }, { "https://site.example/": { body: stuck } });
    const started = Date.now();
    expect(await web.fetcher({ totalMs: 200 }).page("https://site.example/")).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    const never = createFetcher({ resolve: () => new Promise(() => {}), transport: async () => { throw new Error("unreachable"); }, limits: { totalMs: 200 } });
    expect(await never.page("https://site.example/")).toBeNull();
  });

  it("images: allowed type with matching magic bytes only, at most 2 MB", async () => {
    const web = fakeWeb({ "img.example": [PUBLIC] }, {
      "https://img.example/ok.png": { headers: { "content-type": "image/png" }, body: PNG },
      "https://img.example/fake.png": { headers: { "content-type": "image/png" }, body: html() },
      "https://img.example/x.svg": { headers: { "content-type": "image/svg+xml" }, body: Buffer.from("<svg/>") },
      "https://img.example/big.png": { headers: { "content-type": "image/png" }, body: Buffer.concat([PNG, Buffer.alloc(LIMITS.imageBytes)]) },
      "https://img.example/declared.png": { headers: { "content-type": "image/png", "content-length": String(LIMITS.imageBytes + 1) }, body: PNG },
    });
    const f = web.fetcher();
    expect(await f.image("https://img.example/ok.png")).toEqual({ contentType: "image/png", bytes: PNG });
    for (const bad of ["fake.png", "x.svg", "big.png", "declared.png"]) expect(await f.image(`https://img.example/${bad}`), bad).toBeNull();
    expect(web.calls.filter((c) => c.url.endsWith("declared.png"))).toHaveLength(1);
  });

  it("decodes a declared charset", async () => {
    const web = fakeWeb({ "site.example": [PUBLIC] }, { "https://site.example/": { headers: { "content-type": "text/html; charset=windows-1252" }, body: Buffer.from([0x3c, 0x62, 0x3e, 0xe9]) } });
    expect((await web.fetcher().page("https://site.example/"))?.html).toBe("<b>é");
  });
});

describe("pinnedTransport (a real socket, local server)", () => {
  const seen: IncomingMessage[] = [];
  let port = 0;
  const server = createServer((req, res) => {
    seen.push(req);
    if (req.url === "/huge") res.setHeader("x-pad", "a".repeat(32 * 1024));
    res.end("ok");
  });
  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());
  const open = (path: string, address = "127.0.0.1") =>
    pinnedTransport({ url: new URL(`http://pinned.example:${port}${path}`), address: { address, family: 4 }, headers: { "user-agent": USER_AGENT }, signal: new AbortController().signal, connectMs: 300 });

  it("connects to the given address, never resolving the name (which does not exist), and keeps Host", async () => {
    const res = await open("/hello");
    expect(res.status).toBe(200);
    res.body.destroy();
    expect(seen.at(-1)!.headers.host).toBe(`pinned.example:${port}`);
    expect(seen.at(-1)!.headers["user-agent"]).toBe(USER_AGENT);
  });

  it("refuses oversized response headers", async () => {
    await expect(open("/huge")).rejects.toThrow();
  });

  it("gives up on a connection that does not open", async () => {
    const started = Date.now();
    await expect(open("/", "10.255.255.1")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(LIMITS.connectMs);
  });

  it("through the fetcher, the same local server is unreachable: loopback is refused before connecting", async () => {
    const before = seen.length;
    const f = createFetcher({ resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    expect(await f.page("http://pinned.example/")).toBeNull();
    expect(seen.length).toBe(before);
  });
});
