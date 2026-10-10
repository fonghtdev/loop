import { MAX_ATTACHMENT_BYTES, Permission as P } from "@loop/shared";
import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { befriend, caller, env, guildWith, PNG, resetDb, setEveryone, signUp as signUpUser, sizeOf, testStorage, uploadAttachment } from "../../test/helpers.js";
import { connect, listen, until } from "../../test/sockets.js";
import { sweepStaleAttachments } from "./sweep.js";

const app = buildApp(env);
const call = caller(app);
const sockets: Socket[] = [];

beforeEach(resetDb);
afterEach(() => {
  sockets.splice(0).forEach((s) => s.disconnect());
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** owner + member in a guild; `friend` is owner's friend with an open DM; `outsider` knows nobody. */
async function setup() {
  const [owner, member, outsider, friend] = await Promise.all(["owner", "member", "outsider", "friend"].map((n) => signUpUser(app, n)));
  const { guild, general } = await guildWith(app, owner, member);
  await befriend(app, owner, friend);
  const dm = (await call("POST", "/dms", owner.token, { userId: friend.id })).json() as { id: string };
  const other = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "other", type: "TEXT" })).json() as { id: string };
  const voice = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "talk", type: "VOICE" })).json() as { id: string };
  return { owner, member, outsider, friend, guild, general, other, voice, dm, inGeneral: { channelId: general.id }, inDm: { dmChannelId: dm.id } };
}
type F = Awaited<ReturnType<typeof setup>>;

const msgUrl = (target: { channelId: string } | { dmChannelId: string }) =>
  "channelId" in target ? `/channels/${target.channelId}/messages` : `/dms/${target.dmChannelId}/messages`;
const attach = (token: string, target: { channelId: string } | { dmChannelId: string }, attachmentIds: string[], content?: string) =>
  call("POST", msgUrl(target), token, { content, attachmentIds });
/** Neither the upload key nor the final key holds anything. */
const gone = async (id: string) => (await sizeOf(`uploads/${id}`)) === null && (await sizeOf(`files/${id}`)) === null;
const request = (token: string, body: object) => call("POST", "/attachments", token, body);
const png = (over: object = {}) => ({ filename: "pic.png", contentType: "image/png", size: PNG.length, ...over });

describe("step 1: POST /attachments", () => {
  it("creates a PENDING row and a presigned PUT; the key never contains user input", async () => {
    const f = await setup();
    const res = await request(f.member.token, png({ filename: "../../etc/passwd", ...f.inGeneral }));
    expect(res.statusCode).toBe(201);
    const { id, uploadUrl, expiresInSeconds, headers } = res.json();
    expect(expiresInSeconds).toBe(300);
    expect(headers).toEqual({ "Content-Type": "image/png" });
    const row = await prisma.attachment.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "PENDING", uploaderId: f.member.id, channelId: f.general.id, dmChannelId: null, filename: "passwd", messageId: null });
    expect(row.objectKey).toBe(`uploads/${id}`);
    expect(new URL(uploadUrl).pathname).toContain(`/uploads/${id}`);
    expect(uploadUrl).not.toContain("passwd");
  });

  it("sanitizes the display name; names with nothing left are 400", async () => {
    const f = await setup();
    const stored = async (filename: string) => {
      const res = await request(f.member.token, png({ filename, ...f.inGeneral }));
      return res.statusCode === 201 ? (await prisma.attachment.findUniqueOrThrow({ where: { id: res.json().id } })).filename : res.statusCode;
    };
    expect(await stored("a/b\\c")).toBe("c");
    expect(await stored("tab\tnl\nnul\0.png")).toBe("tabnlnul.png");
    expect(await stored("x".repeat(300))).toBe("x".repeat(255));
    for (const bad of ["", "...", "///", "\0\n"]) expect(await stored(bad), JSON.stringify(bad)).toBe(400);
  });

  it("400 for oversize, zero size, disallowed types and bad targets", async () => {
    const f = await setup();
    const status = async (over: object) => (await request(f.member.token, png({ ...f.inGeneral, ...over }))).statusCode;
    expect(await status({ size: MAX_ATTACHMENT_BYTES + 1 })).toBe(400);
    expect(await status({ size: MAX_ATTACHMENT_BYTES })).toBe(201);
    expect(await status({ size: 0 })).toBe(400);
    for (const contentType of ["image/svg+xml", "text/html", "application/x-msdownload", "application/octet-stream", "image/PNG"])
      expect(await status({ contentType }), contentType).toBe(400);
    expect(await status({ dmChannelId: f.dm.id })).toBe(400); // both targets
    expect((await request(f.member.token, png())).statusCode).toBe(400); // neither
    expect(await status({ channelId: f.voice.id })).toBe(400);
  });

  it("at most 20 pending uploads per user (429), and the cap is per user", async () => {
    const f = await setup();
    await prisma.attachment.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({ uploaderId: f.member.id, channelId: f.general.id, objectKey: `uploads/cap-${i}`, filename: "a", contentType: "image/png", size: 1 })),
    });
    expect((await request(f.member.token, png(f.inGeneral))).statusCode).toBe(429);
    expect((await request(f.owner.token, png(f.inGeneral))).statusCode).toBe(201);
  });

  it("follows SEND_MESSAGES: no SEND -> 403, no VIEW -> 404, stranger -> 404", async () => {
    const f = await setup();
    await setEveryone(f.guild.id, P.VIEW_CHANNEL);
    expect((await request(f.member.token, png(f.inGeneral))).statusCode).toBe(403);
    await setEveryone(f.guild.id, 0);
    expect((await request(f.member.token, png(f.inGeneral))).statusCode).toBe(404);
    expect((await request(f.outsider.token, png(f.inGeneral))).statusCode).toBe(404);
    expect((await request(f.owner.token, png(f.inGeneral))).statusCode).toBe(201);
    for (const target of [{ channelId: "nope" }, { dmChannelId: "nope" }, { channelId: "00000000-0000-4000-8000-000000000000" }])
      expect((await request(f.owner.token, png(target))).statusCode).toBe(404);
  });

  it("DM targets need a participant who is a friend and not blocked", async () => {
    const f = await setup();
    expect((await request(f.owner.token, png(f.inDm))).statusCode).toBe(201);
    expect((await request(f.outsider.token, png(f.inDm))).statusCode).toBe(404);
    await call("DELETE", `/friends/${f.friend.id}`, f.owner.token);
    expect((await request(f.owner.token, png(f.inDm))).statusCode).toBe(403);
    await befriend(app, f.owner, f.friend);
    await call("PUT", `/blocks/${f.friend.id}`, f.owner.token);
    expect((await request(f.friend.token, png(f.inDm))).statusCode).toBe(403);
  });
});

describe("steps 2-3: upload and complete", () => {
  it("a real upload becomes READY; completing again is idempotent", async () => {
    const f = await setup();
    const up = await uploadAttachment(app, f.member.token, f.inGeneral);
    expect(up.put!.status).toBe(200);
    expect(up.complete.statusCode).toBe(200);
    expect(up.dto).toMatchObject({ id: up.id, filename: "pic.png", contentType: "image/png", size: PNG.length });
    expect(Object.keys(up.dto).sort()).toEqual(["contentType", "filename", "id", "size", "url"]);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: up.id } })).status).toBe("READY");
    expect((await call("POST", `/attachments/${up.id}/complete`, f.member.token)).statusCode).toBe(200);
  });

  it("only the uploader can complete; others, unknown and malformed ids get 404", async () => {
    const f = await setup();
    const { id } = (await request(f.member.token, png(f.inGeneral))).json();
    for (const [token, target] of [[f.owner.token, id], [f.outsider.token, id], [f.member.token, "00000000-0000-4000-8000-000000000000"], [f.member.token, "nope"]] as const)
      expect((await call("POST", `/attachments/${target}/complete`, token)).statusCode).toBe(404);
  });

  it("a missing object is rejected and the row removed", async () => {
    const f = await setup();
    const { id } = (await request(f.member.token, png(f.inGeneral))).json();
    expect((await call("POST", `/attachments/${id}/complete`, f.member.token)).statusCode).toBe(400);
    expect(await prisma.attachment.count()).toBe(0);
  });

  it("size lie: the stored size differs from the declared one -> 400, object and row deleted", async () => {
    const f = await setup();
    // the signed PUT already pins the length, so make the declared size disagree after a faithful upload
    const row = (await request(f.member.token, png(f.inGeneral))).json();
    await fetch(row.uploadUrl, { method: "PUT", headers: row.headers, body: PNG });
    await prisma.attachment.update({ where: { id: row.id }, data: { size: PNG.length - 1 } });
    expect((await call("POST", `/attachments/${row.id}/complete`, f.member.token)).statusCode).toBe(400);
    expect(await gone(row.id)).toBe(true);
    expect(await prisma.attachment.findUnique({ where: { id: row.id } })).toBeNull();
  });

  it("uploading more bytes than declared never yields a READY attachment", async () => {
    const f = await setup();
    const big = Buffer.concat([PNG, Buffer.alloc(1000)]);
    const up = await uploadAttachment(app, f.member.token, f.inGeneral, big, { size: PNG.length });
    expect(up.put!.status).toBe(403); // storage itself refuses a body that is not the signed length
    expect(up.complete.statusCode).toBe(400);
    expect(await prisma.attachment.count()).toBe(0);
  });

  it("type lie: html / exe bytes declared as png are rejected and deleted", async () => {
    const f = await setup();
    for (const evil of [Buffer.from("<html><script>alert(1)</script></html>"), Buffer.from("MZ\x90\x00\x03\x00\x00\x00")]) {
      const up = await uploadAttachment(app, f.member.token, f.inGeneral, evil);
      expect(up.put!.status).toBe(200);
      expect(up.complete.statusCode).toBe(400);
      expect(up.complete.json().error).toMatch(/does not match/);
      expect(await gone(up.id)).toBe(true);
    }
    expect(await prisma.attachment.count()).toBe(0);
  });

  it("png bytes declared as pdf or zip are rejected too", async () => {
    const f = await setup();
    for (const contentType of ["application/pdf", "application/zip", "video/mp4"])
      expect((await uploadAttachment(app, f.member.token, f.inGeneral, PNG, { contentType })).complete.statusCode, contentType).toBe(400);
  });

  it("only the verified copy is served: a re-PUT after complete changes nothing, and is cleaned up", async () => {
    const f = await setup();
    const { id, uploadUrl, headers } = (await request(f.member.token, png(f.inGeneral))).json();
    await fetch(uploadUrl, { method: "PUT", headers, body: PNG });
    const done = (await call("POST", `/attachments/${id}/complete`, f.member.token)).json();
    expect(await sizeOf(`uploads/${id}`)).toBeNull(); // moved, not copied
    const evil = Buffer.alloc(PNG.length, "X");
    expect((await fetch(uploadUrl, { method: "PUT", headers, body: evil })).status).toBe(200); // the URL is still valid
    expect(Buffer.from(await (await fetch(done.url)).arrayBuffer()).equals(PNG)).toBe(true);
    const msg = (await attach(f.member.token, f.inGeneral, [id])).json();
    const fresh = (await call("GET", `/attachments/${id}`, f.owner.token)).json();
    expect(Buffer.from(await (await fetch(fresh.url)).arrayBuffer()).equals(PNG)).toBe(true);
    await call("DELETE", `/messages/${msg.id}`, f.member.token);
    expect(await gone(id)).toBe(true); // including the re-PUT leftover
  });

  it.each(["firstBytes", "copy"] as const)("an overwrite after the HEAD but before %s is rejected, nothing is kept", async (step) => {
    const f = await setup();
    const { id, uploadUrl, headers } = (await request(f.member.token, png(f.inGeneral))).json();
    await fetch(uploadUrl, { method: "PUT", headers, body: PNG });
    const original = app.storage[step];
    const spy = vi.spyOn(app.storage, step).mockImplementation(async (...args: never[]) => {
      await fetch(uploadUrl, { method: "PUT", headers, body: Buffer.alloc(PNG.length, "X") }); // swapped under our feet
      return (original as (...a: never[]) => Promise<unknown>)(...args) as never;
    });
    const res = await call("POST", `/attachments/${id}/complete`, f.member.token);
    spy.mockRestore();
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/changed during verification/);
    expect(await gone(id)).toBe(true);
    expect(await prisma.attachment.count()).toBe(0);
  });

  it("completing re-checks the target: a user who lost SEND_MESSAGES gets 403, then 404 without VIEW", async () => {
    const f = await setup();
    const { id, uploadUrl, headers } = (await request(f.member.token, png(f.inGeneral))).json();
    await fetch(uploadUrl, { method: "PUT", headers, body: PNG });
    await setEveryone(f.guild.id, P.VIEW_CHANNEL);
    expect((await call("POST", `/attachments/${id}/complete`, f.member.token)).statusCode).toBe(403);
    await setEveryone(f.guild.id, 0);
    expect((await call("POST", `/attachments/${id}/complete`, f.member.token)).statusCode).toBe(404);
    await setEveryone(f.guild.id, P.VIEW_CHANNEL | P.SEND_MESSAGES);
    expect((await call("POST", `/attachments/${id}/complete`, f.member.token)).statusCode).toBe(200);
  });

  it("a DM upload cannot be completed after the friendship ends", async () => {
    const f = await setup();
    const { id, uploadUrl, headers } = (await request(f.owner.token, png(f.inDm))).json();
    await fetch(uploadUrl, { method: "PUT", headers, body: PNG });
    await call("DELETE", `/friends/${f.friend.id}`, f.owner.token);
    expect((await call("POST", `/attachments/${id}/complete`, f.owner.token)).statusCode).toBe(403);
  });
});

describe("step 4: sending with attachmentIds", () => {
  it("end to end: message:new carries a working url, history shows it, deleting removes the object", async () => {
    const f = await setup();
    const port = await listen(app);
    const s = await connect(port, f.owner.token, ["message:new"], sockets);
    await s.emitWithAck("channel:subscribe", { channelId: f.general.id });
    const up = await uploadAttachment(app, f.member.token, f.inGeneral);
    const res = await attach(f.member.token, f.inGeneral, [up.id], "look");
    expect(res.statusCode).toBe(201);
    const msg = res.json();
    expect(msg.attachments).toMatchObject([{ id: up.id, filename: "pic.png", contentType: "image/png", size: PNG.length }]);
    await until(() => s.got["message:new"]!.length);
    const pushed = s.got["message:new"]![0].attachments[0];
    expect(pushed).toMatchObject({ id: up.id, filename: "pic.png", contentType: "image/png", size: PNG.length });
    const file = await fetch(pushed.url);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
    const history = (await call("GET", msgUrl(f.inGeneral), f.owner.token)).json().messages;
    expect(history[0].attachments[0]).toMatchObject({ id: up.id });
    expect((await call("DELETE", `/messages/${msg.id}`, f.member.token)).statusCode).toBe(204);
    expect(await gone(up.id)).toBe(true);
    expect(await prisma.attachment.count()).toBe(0);
  });

  it("DM messages carry attachments through send and history", async () => {
    const f = await setup();
    const up = await uploadAttachment(app, f.owner.token, f.inDm);
    const res = await attach(f.owner.token, f.inDm, [up.id]);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ content: "", dmChannelId: f.dm.id, attachments: [{ id: up.id }] });
    const history = (await call("GET", msgUrl(f.inDm), f.friend.token)).json().messages;
    expect(history[0].attachments).toHaveLength(1);
    expect(Buffer.from(await (await fetch(history[0].attachments[0].url)).arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("a message needs content or an attachment; at most 10, no duplicates", async () => {
    const f = await setup();
    const up = await uploadAttachment(app, f.member.token, f.inGeneral);
    const status = async (body: object) => (await call("POST", msgUrl(f.inGeneral), f.member.token, body)).statusCode;
    expect(await status({ content: "" })).toBe(400);
    expect(await status({ attachmentIds: [] })).toBe(400);
    expect(await status({ content: "   ", attachmentIds: [] })).toBe(400);
    expect(await status({ content: "bad\0", attachmentIds: [up.id] })).toBe(400);
    expect(await status({ attachmentIds: [up.id, up.id] })).toBe(400);
    expect(await status({ attachmentIds: Array.from({ length: 11 }, () => crypto.randomUUID()) })).toBe(400);
    expect(await status({ attachmentIds: [up.id] })).toBe(201);
  });

  it("every unusable id gets the same 400: unknown, malformed, someone else's, pending", async () => {
    const f = await setup();
    const theirs = await uploadAttachment(app, f.owner.token, f.inGeneral);
    const pending = (await request(f.member.token, png(f.inGeneral))).json().id as string;
    const bodies = new Set<string>();
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope", theirs.id, pending]) {
      const res = await attach(f.member.token, f.inGeneral, [id], "x");
      expect(res.statusCode, id).toBe(400);
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: theirs.id } })).messageId).toBeNull();
    expect(await prisma.message.count()).toBe(0);
  });

  it("an attachment belongs to its own conversation: channel A -> channel B, channel <-> DM", async () => {
    const f = await setup();
    const inA = await uploadAttachment(app, f.owner.token, f.inGeneral);
    const inDm = await uploadAttachment(app, f.owner.token, f.inDm);
    expect((await attach(f.owner.token, { channelId: f.other.id }, [inA.id], "x")).statusCode).toBe(400);
    expect((await attach(f.owner.token, f.inDm, [inA.id], "x")).statusCode).toBe(400);
    expect((await attach(f.owner.token, f.inGeneral, [inDm.id], "x")).statusCode).toBe(400);
    expect((await attach(f.owner.token, f.inGeneral, [inA.id], "x")).statusCode).toBe(201);
    expect((await attach(f.owner.token, f.inDm, [inDm.id], "x")).statusCode).toBe(201);
  });

  it("one attachment, one message: a second claim fails", async () => {
    const f = await setup();
    const up = await uploadAttachment(app, f.member.token, f.inGeneral);
    expect((await attach(f.member.token, f.inGeneral, [up.id])).statusCode).toBe(201);
    expect((await attach(f.member.token, f.inGeneral, [up.id])).statusCode).toBe(400);
  });

  it("concurrent claims: exactly one message wins and the loser leaves no message behind", async () => {
    const f = await setup();
    const up = await uploadAttachment(app, f.member.token, f.inGeneral);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => attach(f.member.token, f.inGeneral, [up.id], `m${i}`)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400, 400, 400, 400, 400]);
    expect(await prisma.message.count()).toBe(1);
  });

  it("a partial failure rolls the whole message back", async () => {
    const f = await setup();
    const good = await uploadAttachment(app, f.member.token, f.inGeneral);
    expect((await attach(f.member.token, f.inGeneral, [good.id, crypto.randomUUID()], "x")).statusCode).toBe(400);
    expect(await prisma.message.count()).toBe(0);
    expect((await prisma.attachment.findUniqueOrThrow({ where: { id: good.id } })).messageId).toBeNull();
  });

  it("DM sending still needs friends and not blocked", async () => {
    const f = await setup();
    const up = await uploadAttachment(app, f.owner.token, f.inDm);
    await call("DELETE", `/friends/${f.friend.id}`, f.owner.token);
    expect((await attach(f.owner.token, f.inDm, [up.id], "x")).statusCode).toBe(403);
  });
});

describe("edit and delete", () => {
  it("edit: text may be emptied only when attachments remain; attachments stay put", async () => {
    const f = await setup();
    const up = await uploadAttachment(app, f.member.token, f.inGeneral);
    const withFile = (await attach(f.member.token, f.inGeneral, [up.id], "before")).json();
    const edited = await call("PATCH", `/messages/${withFile.id}`, f.member.token, { content: "" });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ content: "", attachments: [{ id: up.id }] });
    const plain = (await call("POST", msgUrl(f.inGeneral), f.member.token, { content: "t" })).json();
    expect((await call("PATCH", `/messages/${plain.id}`, f.member.token, { content: "  " })).statusCode).toBe(400);
  });

  it("deleting a message whose object is already gone still succeeds", async () => {
    const f = await setup();
    const up = await uploadAttachment(app, f.member.token, f.inGeneral);
    const msg = (await attach(f.member.token, f.inGeneral, [up.id])).json();
    await testStorage.remove(`files/${up.id}`);
    expect((await call("DELETE", `/messages/${msg.id}`, f.member.token)).statusCode).toBe(204);
  });
});

describe("GET /attachments/:id", () => {
  it("pending and unattached uploads are visible to the uploader only", async () => {
    const f = await setup();
    const { id } = (await request(f.member.token, png(f.inGeneral))).json();
    expect((await call("GET", `/attachments/${id}`, f.member.token)).statusCode).toBe(200);
    for (const token of [f.owner.token, f.outsider.token]) expect((await call("GET", `/attachments/${id}`, token)).statusCode).toBe(404);
  });

  it("attached: readers get a fresh url; strangers, unknown and malformed ids get the same 404", async () => {
    const f = await setup();
    const up = await uploadAttachment(app, f.member.token, f.inGeneral);
    await attach(f.member.token, f.inGeneral, [up.id]);
    const ok = await call("GET", `/attachments/${up.id}`, f.owner.token);
    expect(ok.statusCode).toBe(200);
    expect(Buffer.from(await (await fetch(ok.json().url)).arrayBuffer()).equals(PNG)).toBe(true);
    const misses = await Promise.all(
      [`/attachments/${up.id}`, "/attachments/00000000-0000-4000-8000-000000000000", "/attachments/nope"].map((u, i) =>
        call("GET", u, i === 0 ? f.outsider.token : f.owner.token),
      ),
    );
    expect(misses.map((r) => r.statusCode)).toEqual([404, 404, 404]);
    expect(new Set(misses.map((r) => r.body)).size).toBe(1);
  });

  it("a member who loses VIEW_CHANNEL loses the file", async () => {
    const f = await setup();
    const up = await uploadAttachment(app, f.owner.token, f.inGeneral);
    await attach(f.owner.token, f.inGeneral, [up.id]);
    expect((await call("GET", `/attachments/${up.id}`, f.member.token)).statusCode).toBe(200);
    await setEveryone(f.guild.id, 0);
    expect((await call("GET", `/attachments/${up.id}`, f.member.token)).statusCode).toBe(404);
    expect((await call("GET", `/attachments/${up.id}`, f.owner.token)).statusCode).toBe(200);
  });

  it("DM attachments: participants only, and still readable after an unfriend", async () => {
    const f = await setup();
    const up = await uploadAttachment(app, f.owner.token, f.inDm);
    await attach(f.owner.token, f.inDm, [up.id]);
    expect((await call("GET", `/attachments/${up.id}`, f.friend.token)).statusCode).toBe(200);
    expect((await call("GET", `/attachments/${up.id}`, f.member.token)).statusCode).toBe(404);
    await call("DELETE", `/friends/${f.friend.id}`, f.owner.token);
    expect((await call("GET", `/attachments/${up.id}`, f.friend.token)).statusCode).toBe(200);
  });
});

describe("download headers", () => {
  const download = async (f: F, bytes: Uint8Array, declared: { filename: string; contentType: string }) => {
    const up = await uploadAttachment(app, f.member.token, f.inGeneral, bytes, declared);
    expect(up.complete.statusCode).toBe(200);
    return fetch(up.dto.url);
  };

  it("images are served inline with the validated type", async () => {
    const res = await download(await setup(), PNG, { filename: "pic.png", contentType: "image/png" });
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
  });

  it("everything else downloads under its sanitized name", async () => {
    const res = await download(await setup(), Buffer.from("%PDF-1.4 x"), { filename: "my report é.pdf", contentType: "application/pdf" });
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''my%20report%20%C3%A9.pdf");
  });
});

describe("sweepStaleAttachments", () => {
  it("removes old PENDING and unattached READY uploads with their objects; keeps attached and fresh ones", async () => {
    const f = await setup();
    const attached = await uploadAttachment(app, f.member.token, f.inGeneral);
    await attach(f.member.token, f.inGeneral, [attached.id]);
    const readyUnused = await uploadAttachment(app, f.member.token, f.inGeneral);
    const pending = (await request(f.member.token, png(f.inGeneral))).json();
    await fetch(pending.uploadUrl, { method: "PUT", headers: pending.headers, body: PNG });

    expect(await sweepStaleAttachments(testStorage)).toBe(0); // nothing is 24 hours old yet
    expect(await sweepStaleAttachments(testStorage, new Date(Date.now() + 60_000))).toBe(2);
    expect(await gone(readyUnused.id)).toBe(true);
    expect(await gone(pending.id)).toBe(true);
    expect(await sizeOf(`files/${attached.id}`)).toBe(PNG.length);
    expect(await prisma.attachment.findMany({ select: { id: true } })).toEqual([{ id: attached.id }]);
  });
});
