import { describe, expect, it, vi } from "vitest";
import type { AttEvent } from "./attachment-machine";
import { ApiError } from "./auth-client";
import { channelKey, dmKey } from "./conversation";
import { createUploader, failureOf, putFile, UploadFailure, type XhrLike } from "./upload-client";

/** A scriptable XMLHttpRequest. */
class FakeXhr implements XhrLike {
  status = 0;
  upload: XhrLike["upload"] = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  sent: Blob | null = null;
  aborted = false;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: Blob) {
    this.sent = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ loaded, total, lengthComputable: true });
  }
  finish(status: number) {
    this.status = status;
    this.onload?.();
  }
}

const png = new File([new Uint8Array(100)], "a.png", { type: "image/png" });
const signal = () => new AbortController().signal;

describe("putFile (XHR, for upload progress)", () => {
  it("PUTs the file with exactly the given headers, reports progress, resolves on 2xx", async () => {
    const xhr = new FakeXhr();
    const progress: number[] = [];
    const done = putFile("http://s3/up", { "Content-Type": "image/png" }, png, (f) => progress.push(f), signal(), () => xhr);
    expect(xhr).toMatchObject({ method: "PUT", url: "http://s3/up", headers: { "Content-Type": "image/png" } });
    expect(xhr.sent).toBe(png);
    xhr.progress(25, 100);
    xhr.progress(100, 100);
    xhr.finish(200);
    await expect(done).resolves.toBeUndefined();
    expect(progress).toEqual([0.25, 1]);
  });
  it("sends no Authorization header (the URL is the credential)", async () => {
    const xhr = new FakeXhr();
    const done = putFile("http://s3/up", { "Content-Type": "image/png" }, png, () => {}, signal(), () => xhr);
    xhr.finish(200);
    await done;
    expect(Object.keys(xhr.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });
  it("a non-2xx answer is a storage failure", async () => {
    const xhr = new FakeXhr();
    const done = putFile("u", {}, png, () => {}, signal(), () => xhr);
    xhr.finish(403);
    await expect(done).rejects.toMatchObject({ reason: "storage" });
  });
  it("a network error is a network failure", async () => {
    const xhr = new FakeXhr();
    const done = putFile("u", {}, png, () => {}, signal(), () => xhr);
    xhr.onerror?.();
    await expect(done).rejects.toMatchObject({ reason: "network" });
  });
  it("aborting the signal aborts the request; an already aborted signal never sends", async () => {
    const ctrl = new AbortController();
    const xhr = new FakeXhr();
    const done = putFile("u", {}, png, () => {}, ctrl.signal, () => xhr);
    ctrl.abort();
    expect(xhr.aborted).toBe(true);
    await expect(done).rejects.toMatchObject({ reason: "aborted" });

    const second = new FakeXhr();
    await expect(putFile("u", {}, png, () => {}, ctrl.signal, () => second)).rejects.toBeInstanceOf(UploadFailure);
    expect(second.sent).toBeNull();
  });
  it("ignores progress events without a length", () => {
    const xhr = new FakeXhr();
    const progress = vi.fn();
    void putFile("u", {}, png, progress, signal(), () => xhr).catch(() => {});
    xhr.upload.onprogress?.({ loaded: 5, total: 0, lengthComputable: false });
    expect(progress).not.toHaveBeenCalled();
  });
});

describe("failureOf (what a failed call means)", () => {
  const api = (status: number) => new ApiError(status, "/attachments");
  it("maps statuses per stage", () => {
    expect(failureOf(api(0), "create")).toBe("network");
    expect(failureOf(api(400), "create")).toBe("rejected");
    expect(failureOf(api(400), "complete")).toBe("mismatch");
    expect(failureOf(api(429), "create")).toBe("tooMany");
    expect(failureOf(api(403), "create")).toBe("denied");
    expect(failureOf(api(404), "complete")).toBe("denied");
    expect(failureOf(api(500), "create")).toBe("unknown");
    expect(failureOf(new Error("x"), "create")).toBe("unknown");
  });
});

describe("the upload flow (reserve, PUT, complete)", () => {
  function setup(opts: { create?: unknown; complete?: unknown } = {}) {
    const xhr = new FakeXhr();
    const calls: string[] = [];
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push(`${method} ${path}`);
      if (path === "/attachments") {
        if (opts.create) throw opts.create;
        return { id: "att1", uploadUrl: "http://s3/up", headers: { "Content-Type": "image/png" }, _body: body };
      }
      if (opts.complete) throw opts.complete;
      return { id: "att1", filename: "a.png", contentType: "image/png", size: 100, url: "http://s3/get" };
    });
    const events: AttEvent[] = [];
    const upload = createUploader({ request: request as never, createXhr: () => xhr });
    const go = (key = channelKey("c1")) => upload({ file: png, filename: "a.png", convKey: key, signal: signal(), emit: (e) => events.push(e) });
    return { xhr, request, calls, events, go };
  }

  it("runs the three steps in order and emits the machine events", async () => {
    const s = setup();
    const result = s.go();
    await vi.waitFor(() => expect(s.xhr.sent).toBe(png));
    s.xhr.progress(50, 100);
    s.xhr.finish(200);
    await expect(result).resolves.toMatchObject({ id: "att1", url: "http://s3/get" });
    expect(s.calls).toEqual(["POST /attachments", "POST /attachments/att1/complete"]);
    expect(s.events.map((e) => e.type)).toEqual(["validate", "valid", "progress", "uploaded"]);
    // the Content-Type of the PUT is the one the server handed out, which is the declared one
    expect(s.xhr.headers).toEqual({ "Content-Type": "image/png" });
  });
  it("declares the real type and size, with the DM target for a DM", async () => {
    const s = setup();
    void s.go(dmKey("d1")).catch(() => {});
    await vi.waitFor(() => expect(s.request).toHaveBeenCalled());
    expect(s.request).toHaveBeenCalledWith("POST", "/attachments", { filename: "a.png", contentType: "image/png", size: 100, dmChannelId: "d1" });
  });
  it("create 400 -> rejected, and nothing is uploaded", async () => {
    const s = setup({ create: new ApiError(400, "/attachments") });
    await expect(s.go()).rejects.toMatchObject({ reason: "rejected" });
    expect(s.xhr.sent).toBeNull();
  });
  it("create 429 -> too many pending", async () => {
    await expect(setup({ create: new ApiError(429, "/attachments") }).go()).rejects.toMatchObject({ reason: "tooMany" });
  });
  it("complete 400 (content does not match) -> mismatch", async () => {
    const s = setup({ complete: new ApiError(400, "/attachments/att1/complete", "File content does not match its type") });
    const result = s.go();
    await vi.waitFor(() => expect(s.xhr.sent).toBe(png));
    s.xhr.finish(200);
    await expect(result).rejects.toMatchObject({ reason: "mismatch" });
  });
  it("complete 403 / 404 -> denied; network down -> network", async () => {
    for (const [err, reason] of [
      [new ApiError(403, "x"), "denied"],
      [new ApiError(404, "x"), "denied"],
      [new ApiError(0, "x"), "network"],
    ] as const) {
      const s = setup({ complete: err });
      const result = s.go();
      await vi.waitFor(() => expect(s.xhr.sent).toBe(png));
      s.xhr.finish(200);
      await expect(result).rejects.toMatchObject({ reason });
    }
  });
  it("a failing PUT never reaches complete", async () => {
    const s = setup();
    const result = s.go();
    await vi.waitFor(() => expect(s.xhr.sent).toBe(png));
    s.xhr.finish(500);
    await expect(result).rejects.toMatchObject({ reason: "storage" });
    expect(s.calls).toEqual(["POST /attachments"]);
  });
});
