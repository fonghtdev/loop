import { IMAGE_MAX_BYTES } from "@loop/shared";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./auth-client";
import { checkImage, createImageUploader, imageFailureText, ImageUploadFailure } from "./image-upload";
import type { XhrLike } from "./upload-client";

class FakeXhr implements XhrLike {
  status = 200;
  upload: XhrLike["upload"] = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open = vi.fn();
  setRequestHeader = vi.fn();
  abort = vi.fn();
  send = vi.fn(() => {
    this.upload.onprogress?.({ loaded: 5, total: 10, lengthComputable: true });
    queueMicrotask(() => this.onload?.());
  });
}

const png = (size = 100) => new File([new Uint8Array(size)], "a.png", { type: "image/png" });
const reserved = { id: "up1", uploadUrl: "http://s3/put", headers: { "Content-Type": "image/png" } };

function setup(script: Partial<Record<"upload" | "complete", unknown>> = {}, xhr = new FakeXhr()) {
  const request = vi.fn(async (_method: string, path: string) => {
    const step = path.endsWith("/upload") ? "upload" : "complete";
    const out = script[step] ?? (step === "upload" ? reserved : { hash: "newhash" });
    if (out instanceof Error) throw out;
    return out;
  });
  return { request, xhr, upload: createImageUploader({ request: request as never, createXhr: () => xhr }) };
}
const fail = async (p: Promise<unknown>) => (await p.then(() => null, (e: ImageUploadFailure) => e))?.reason;

describe("checkImage (before any request)", () => {
  it("accepts the four image types up to the limit of the kind", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) expect(checkImage({ type, size: 10 }, "avatar")).toBeNull();
    expect(checkImage({ type: "image/png", size: IMAGE_MAX_BYTES.avatar }, "avatar")).toBeNull();
  });
  it("refuses other types (svg too), empty files and files over the limit; banner allows more than avatar", () => {
    expect(checkImage({ type: "image/svg+xml", size: 10 }, "avatar")).toBe("type");
    expect(checkImage({ type: "", size: 10 }, "icon")).toBe("type");
    expect(checkImage({ type: "image/png", size: 0 }, "avatar")).toBe("size");
    expect(checkImage({ type: "image/png", size: IMAGE_MAX_BYTES.avatar + 1 }, "avatar")).toBe("size");
    expect(checkImage({ type: "image/png", size: IMAGE_MAX_BYTES.avatar + 1 }, "banner")).toBeNull();
  });
});

describe("image upload sequence", () => {
  it("reserves, PUTs to the storage URL with the server's headers, completes, and returns the hash", async () => {
    const { upload, request, xhr } = setup();
    const progress: number[] = [];
    const file = png();
    await expect(upload({ base: "/me/avatar", kind: "avatar", file, onProgress: (f) => progress.push(f) })).resolves.toBe("newhash");
    expect(request.mock.calls).toEqual([
      ["POST", "/me/avatar/upload", { contentType: "image/png", size: 100 }],
      ["POST", "/me/avatar/complete", { id: "up1" }],
    ]);
    expect(xhr.open).toHaveBeenCalledWith("PUT", "http://s3/put");
    expect(xhr.setRequestHeader).toHaveBeenCalledWith("Content-Type", "image/png");
    expect(xhr.send).toHaveBeenCalledWith(file);
    expect(progress).toEqual([0.5]);
  });
  it("uses the base it is given (server icon)", async () => {
    const { upload, request } = setup();
    await upload({ base: "/guilds/g1/icon", kind: "icon", file: png() });
    expect(request.mock.calls.map((c) => c[1])).toEqual(["/guilds/g1/icon/upload", "/guilds/g1/icon/complete"]);
  });
  it("a wrong type or size is refused with no request at all", async () => {
    const { upload, request, xhr } = setup();
    expect(await fail(upload({ base: "/me/avatar", kind: "avatar", file: new File([new Uint8Array(3)], "a.svg", { type: "image/svg+xml" }) }))).toBe("type");
    expect(await fail(upload({ base: "/me/avatar", kind: "avatar", file: png(IMAGE_MAX_BYTES.avatar + 1) }))).toBe("size");
    expect(request).not.toHaveBeenCalled();
    expect(xhr.open).not.toHaveBeenCalled();
  });
  it.each([
    ["reserve refused (400)", { upload: new ApiError(400, "/me/avatar/upload") }, "rejected"],
    ["reserve rate limited", { upload: new ApiError(429, "/me/avatar/upload") }, "tooMany"],
    ["reserve without the right", { upload: new ApiError(403, "/guilds/g/icon/upload") }, "denied"],
    ["offline", { upload: new ApiError(0, "/me/avatar/upload") }, "network"],
    ["complete says the upload expired", { complete: new ApiError(400, "/me/avatar/complete", "Upload expired") }, "expired"],
    ["complete says the bytes do not match", { complete: new ApiError(400, "/me/avatar/complete", "File content does not match") }, "mismatch"],
    ["complete id unknown (404)", { complete: new ApiError(404, "/me/avatar/complete") }, "denied"],
    ["server error", { complete: new ApiError(500, "/me/avatar/complete") }, "unknown"],
  ])("%s", async (_name, script, reason) => {
    const { upload } = setup(script);
    expect(await fail(upload({ base: "/me/avatar", kind: "avatar", file: png() }))).toBe(reason);
  });
  it("a storage failure stops before complete", async () => {
    const xhr = new FakeXhr();
    xhr.status = 403;
    const { upload, request } = setup({}, xhr);
    expect(await fail(upload({ base: "/me/avatar", kind: "avatar", file: png() }))).toBe("storage");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("every failure has Vietnamese words (the size one names the limit)", () => {
    expect(imageFailureText("size", "avatar")).toMatch(/8 MB/);
    expect(imageFailureText("size", "banner")).toMatch(/10 MB/);
    expect(imageFailureText("expired", "avatar")).toMatch(/hết hạn/);
    expect(imageFailureText("type", "icon")).toMatch(/PNG/);
  });
});
