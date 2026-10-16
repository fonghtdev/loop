import { DisconnectReason } from "livekit-client";
import { describe, expect, it, vi } from "vitest";
import { createCalls, FRESH_CALL_MS, RING_MS } from "./calls";
import { setupVoice } from "./voice-fakes";

function setup(onRoom?: Parameters<typeof setupVoice>[1], groups: string[] = []) {
  const v = setupVoice({}, onRoom);
  const timers: { fn: () => void; ms: number; id: number; live: boolean }[] = [];
  const declineRequest = vi.fn(async () => undefined);
  const calls = createCalls({
    voice: v.voice,
    request: declineRequest,
    isGroup: (id) => groups.includes(id),
    now: () => v.tick(0),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms, id: timers.length, live: true });
      return timers.length - 1;
    },
    clearTimer: (id) => {
      if (timers[id as number]) timers[id as number].live = false;
    },
  });
  const incoming = (dmChannelId = "d1", video = false) => calls.handle({ type: "incoming", dmChannelId, from: { id: "u2", username: "Lan" }, video });
  const ended = (dmChannelId = "d1") => calls.handle({ type: "ended", dmChannelId });
  const st = () => calls.store.getState();
  const fireTimers = () => timers.filter((t) => t.live).forEach((t) => t.fn());
  return { ...v, calls, declineRequest, timers, incoming, ended, st, fireTimers };
}

describe("outgoing calls", () => {
  it("start joins the DM room and rings until the other side is in the room", async () => {
    const s = setup();
    await s.calls.start("d1", "Lan", true);
    expect(s.declineRequest).not.toHaveBeenCalled();
    expect(s.request).toHaveBeenCalledWith("POST", "/dms/d1/call", { video: true });
    expect(s.state().target).toMatchObject({ kind: "dm", id: "d1" });
    expect(s.st().ringing).toMatchObject({ dmId: "d1", name: "Lan" });
    expect(s.timers[0].ms).toBe(RING_MS);
    s.room().addRemote("u2", "Lan"); // answered
    expect(s.st().ringing).toBeNull();
    expect(s.timers[0].live).toBe(false);
    expect(s.state().status).toBe("connected"); // active
  });

  it("calling into a room where the other side already is is an answer: nothing rings", async () => {
    const s = setup((r) => r.remoteParticipants.set("u2", { identity: "u2", name: "Lan", getTrackPublication: () => undefined }));
    await s.calls.start("d1", "Lan", false);
    expect(s.st().ringing).toBeNull();
    expect(s.timers).toHaveLength(0);
  });

  it("the caller cancels: the room is left and the ring state cleared", async () => {
    const s = setup();
    await s.calls.start("d1", "Lan", false);
    s.calls.cancel();
    expect(s.state().status).toBe("idle");
    expect(s.room().disconnected).toBe(1);
    expect(s.st().ringing).toBeNull();
    expect(s.timers[0].live).toBe(false);
  });

  it("nobody answers within the timeout: the caller hangs up with a message", async () => {
    const s = setup();
    await s.calls.start("d1", "Lan", false);
    s.fireTimers();
    expect(s.state().status).toBe("idle");
    expect(s.state().notice).toBe("Lan không trả lời.");
    expect(s.st().ringing).toBeNull();
  });

  it("the timeout of an earlier call does not hang up a later one", async () => {
    const s = setup();
    await s.calls.start("d1", "Lan", false);
    const first = s.timers[0];
    s.calls.cancel();
    await s.calls.start("d1", "Lan", false);
    first.fn(); // a timer that should have been cleared fires late
    expect(s.state().status).toBe("connected");
    expect(s.st().ringing).not.toBeNull();
  });

  it("call:declined ends the matching outgoing call with a message; another DM's is ignored", async () => {
    const s = setup();
    await s.calls.start("d1", "Lan", false);
    s.calls.handle({ type: "declined", dmChannelId: "other", by: { id: "x" } });
    expect(s.state().status).toBe("connected");
    s.calls.handle({ type: "declined", dmChannelId: "d1", by: { id: "u2" } });
    expect(s.state().status).toBe("idle");
    expect(s.state().notice).toBe("Lan đã từ chối cuộc gọi.");
    expect(s.st().ringing).toBeNull();
  });

  it("in a group, one person declining keeps the call ringing for the others", async () => {
    const s = setup(undefined, ["g1"]);
    await s.calls.start("g1", "Nhóm", false);
    s.calls.handle({ type: "declined", dmChannelId: "g1", by: { id: "u2" } });
    expect(s.state().status).toBe("connected");
    expect(s.st().ringing).not.toBeNull();
    expect(s.state().notice).toBeNull();
  });

  it("a stale decline (no outgoing call) does nothing", async () => {
    const s = setup();
    await s.voice.joinChannel("c1", "Phòng");
    s.calls.handle({ type: "declined", dmChannelId: "d1", by: { id: "u2" } });
    expect(s.state().status).toBe("connected");
    expect(s.state().notice).toBeNull();
  });
});

describe("incoming calls", () => {
  it("shows the dialog state; accept posts the call (joins) and clears it", async () => {
    const s = setup();
    s.incoming("d1", true);
    expect(s.st().incoming).toEqual({ dmId: "d1", from: { id: "u2", username: "Lan" }, video: true });
    await s.calls.accept();
    expect(s.st().incoming).toBeNull();
    expect(s.request).toHaveBeenCalledWith("POST", "/dms/d1/call", { video: true });
    expect(s.state().target).toMatchObject({ kind: "dm", id: "d1", name: "Lan" });
  });

  it("decline posts /call/decline and clears; a failed decline request is swallowed", async () => {
    const s = setup();
    s.incoming("d1");
    await s.calls.decline();
    expect(s.st().incoming).toBeNull();
    expect(s.declineRequest).toHaveBeenCalledWith("POST", "/dms/d1/call/decline");
    s.declineRequest.mockRejectedValueOnce(new Error("net"));
    s.incoming("d1");
    await expect(s.calls.decline()).resolves.toBeUndefined();
  });

  it("accept/decline with nothing incoming do nothing", async () => {
    const s = setup();
    await s.calls.accept();
    await s.calls.decline();
    expect(s.request).not.toHaveBeenCalled();
    expect(s.declineRequest).not.toHaveBeenCalled();
    expect(s.state().status).toBe("idle");
  });

  it("while in a voice channel the dialog shows but nothing switches until Accept, which leaves the channel", async () => {
    const s = setup();
    await s.voice.joinChannel("c1", "Phòng");
    s.incoming("d1");
    expect(s.st().incoming).not.toBeNull();
    expect(s.state().target).toMatchObject({ kind: "channel", id: "c1" });
    expect(s.rooms[0].disconnected).toBe(0);
    await s.calls.accept();
    expect(s.rooms[0].disconnected).toBe(1);
    expect(s.state().target).toMatchObject({ kind: "dm", id: "d1" });
  });

  it("a ring for the DM call we are already in is ignored (stale)", async () => {
    const s = setup();
    await s.voice.joinDm("d1", "Lan", false);
    s.incoming("d1");
    expect(s.st().incoming).toBeNull();
    s.incoming("d2"); // another DM does ring
    expect(s.st().incoming?.dmId).toBe("d2");
  });

  it("the caller gives up (call:ended for that DM): the dialog goes away; another DM's end does not touch it", async () => {
    const s = setup();
    s.incoming("d1");
    s.ended("other");
    expect(s.st().incoming?.dmId).toBe("d1");
    s.ended("d1");
    expect(s.st().incoming).toBeNull();
  });

  it("accepting a stale/other DM's dialog never joins the wrong call", async () => {
    const s = setup();
    s.incoming("d1");
    s.incoming("d2"); // newest wins
    await s.calls.accept();
    expect(s.state().target?.id).toBe("d2");
    expect(s.request).toHaveBeenCalledTimes(1);
    expect(s.request.mock.calls[0][1]).toBe("/dms/d2/call");
  });

  it("starting a call to someone who is ringing us answers instead of ringing back", async () => {
    const s = setup();
    s.incoming("d1");
    await s.calls.start("d1", "Lan", false);
    expect(s.st().incoming).toBeNull();
  });
});

describe("call:ended", () => {
  const activeCall = async () => {
    const s = setup();
    await s.calls.start("d1", "Lan", false);
    s.room().addRemote("u2", "Lan");
    s.tick(FRESH_CALL_MS + 1);
    return s;
  };

  it("ends the call it belongs to, once, with one message", async () => {
    const s = await activeCall();
    s.ended("d1");
    expect(s.state()).toMatchObject({ status: "idle", notice: "Cuộc gọi đã kết thúc." });
    expect(s.room().disconnected).toBe(1);
    s.voice.dismissNotice();
    s.ended("d1");
    s.ended("d1");
    expect(s.state().notice).toBeNull(); // idempotent: repeats do nothing
    expect(s.room().disconnected).toBe(1);
  });

  it("another DM's end never touches this call, nor a voice channel session", async () => {
    const s = await activeCall();
    s.ended("d2");
    expect(s.state().status).toBe("connected");
    const v = setup();
    await v.voice.joinChannel("d1", "channel with the same id");
    v.tick(FRESH_CALL_MS + 1);
    v.ended("d1");
    expect(v.state().status).toBe("connected");
  });

  it("a repeat of an old end never ends a NEWER call started in the same DM", async () => {
    const s = await activeCall();
    s.ended("d1"); // first end
    await s.calls.start("d1", "Lan", false); // user calls again right away
    s.room().addRemote("u2", "Lan");
    s.ended("d1"); // the server's repeat of the first end
    s.ended("d1");
    expect(s.state()).toMatchObject({ status: "connected", notice: null });
    s.tick(FRESH_CALL_MS + 1);
    s.ended("d1"); // a real end later does end it
    expect(s.state().status).toBe("idle");
  });

  it("a block mid-call: LiveKit's disconnect ends it with its own message and the repeated events add nothing", async () => {
    const s = await activeCall();
    s.room().fire("disconnected", DisconnectReason.ROOM_DELETED);
    expect(s.state()).toMatchObject({ status: "disconnected", notice: "Cuộc gọi đã kết thúc." });
    s.ended("d1");
    s.ended("d1");
    s.ended("d1");
    s.ended("d1");
    expect(s.state()).toMatchObject({ status: "disconnected", notice: "Cuộc gọi đã kết thúc." });
    expect(s.rooms).toHaveLength(1);
  });

  it("ended while ringing (old enough) hangs up the call", async () => {
    const s = setup();
    await s.calls.start("d1", "Lan", false);
    s.tick(FRESH_CALL_MS + 1);
    s.ended("d1");
    expect(s.state().status).toBe("idle");
    expect(s.st().ringing).toBeNull();
  });
});

describe("reset", () => {
  it("clears the dialog and the ring (sign-out)", async () => {
    const s = setup();
    s.incoming("d2");
    await s.calls.start("d1", "Lan", false);
    s.calls.reset();
    expect(s.st()).toEqual({ incoming: null, ringing: null });
    expect(s.timers.every((t) => !t.live)).toBe(true);
  });
});
