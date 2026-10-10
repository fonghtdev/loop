import { DisconnectReason } from "livekit-client";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./auth-client";
import { audioTrack, FakeRoom, setupVoice } from "./voice-fakes";
import { disconnectMessage, rightsOf } from "./voice";

const joined = async (token = {}) => {
  const s = setupVoice(token);
  await s.voice.joinChannel("c1", "Phòng họp");
  return s;
};

describe("join", () => {
  it("walks idle -> requestingToken -> connecting -> connected and publishes the mic when allowed", async () => {
    const seen: string[] = [];
    const s = setupVoice();
    s.voice.store.subscribe((st) => seen.push(st.status));
    expect(s.state().status).toBe("idle");
    await s.voice.joinChannel("c1", "Phòng họp");
    expect([...new Set(seen)]).toEqual(["requestingToken", "connecting", "connected"]);
    expect(s.request).toHaveBeenCalledWith("POST", "/channels/c1/voice/token", undefined);
    expect(s.state()).toMatchObject({ status: "connected", canSpeak: true, canVideo: true, micEnabled: true, target: { kind: "channel", id: "c1" } });
    expect(s.room().mic).toEqual([true]);
    expect(s.state().participants.map((p) => p.userId)).toEqual(["me"]);
  });

  it("a DM call posts to the call endpoint with the video flag", async () => {
    const s = setupVoice();
    await s.voice.joinDm("d1", "Lan", true);
    expect(s.request).toHaveBeenCalledWith("POST", "/dms/d1/call", { video: true });
    expect(s.room().cam).toEqual([true]);
  });

  it("joining the same target again does nothing; joining another leaves the first room first (one session)", async () => {
    const s = await joined();
    await s.voice.joinChannel("c1", "x");
    expect(s.rooms).toHaveLength(1);
    await s.voice.joinChannel("c2", "Khác");
    expect(s.rooms).toHaveLength(2);
    expect(s.rooms[0].disconnected).toBe(1);
    expect(s.rooms[1].disconnected).toBe(0);
    expect(s.state().target?.id).toBe("c2");
    await s.voice.joinDm("d1", "Lan", false);
    expect(s.rooms[1].disconnected).toBe(1);
    expect(s.state().target).toMatchObject({ kind: "dm", id: "d1" });
  });

  it.each([
    [403, "voice.errors.noConnect"],
    [404, "voice.errors.gone"],
    [400, "voice.errors.notVoice"],
    [409, "voice.errors.full"],
    [500, "errors.server"],
    [0, "errors.offline"],
  ])("token %i becomes the Vietnamese message and no room is created", async (status, _key) => {
    const s = setupVoice();
    s.request.mockRejectedValueOnce(new ApiError(status, "/channels/c1/voice/token", "x"));
    await s.voice.joinChannel("c1", "n");
    expect(s.state()).toMatchObject({ status: "disconnected", target: null });
    expect(s.state().notice).toMatch(/[ạảãàáâăêôơưđ]|Không|Máy|Bạn/);
    expect(s.rooms).toHaveLength(0);
  });

  it("refuses a token whose url is not the configured LiveKit origin, without connecting", async () => {
    const s = setupVoice({ url: "ws://evil.example" });
    await s.voice.joinChannel("c1", "n");
    expect(s.rooms).toHaveLength(0);
    expect(s.state()).toMatchObject({ status: "disconnected", notice: expect.stringContaining("cấu hình") });
  });

  it("a LiveKit connect failure ends in disconnected with a message and releases the room", async () => {
    const s = setupVoice({}, (r) => (r.connectError = new Error("boom")));
    await s.voice.joinChannel("c1", "n");
    expect(s.state()).toMatchObject({ status: "disconnected", notice: "Không kết nối được tới máy chủ thoại. Kiểm tra mạng rồi thử lại." });
    expect(s.room().disconnected).toBe(1);
    expect(s.sink.tracks.size).toBe(0);
  });

  it("leaving while the token is still being requested cancels the join (no room is ever connected)", async () => {
    const s = setupVoice();
    let release!: () => void;
    s.request.mockImplementationOnce(() => new Promise((r) => (release = () => r({ token: "t", url: "ws://lk", canSpeak: true, canVideo: true }))));
    const joining = s.voice.joinChannel("c1", "n");
    s.voice.leave();
    release();
    expect(await joining).toBe(false);
    expect(s.rooms).toHaveLength(0);
    expect(s.state().status).toBe("idle");
  });
});

describe("leave and leaks", () => {
  it("leave disconnects the room, empties the audio sink and resets everything", async () => {
    const s = await joined();
    s.room().fire("trackSubscribed", audioTrack());
    expect(s.sink.tracks.size).toBe(1);
    s.voice.leave();
    expect(s.room().disconnected).toBe(1);
    expect(s.sink.tracks.size).toBe(0);
    expect(s.state()).toMatchObject({ status: "idle", target: null, micEnabled: false, participants: [] });
  });

  it("sign-out path: leave() from any state disconnects exactly once and later room events are ignored", async () => {
    const s = await joined();
    const room = s.room();
    s.voice.leave();
    s.voice.leave();
    expect(room.disconnected).toBe(1);
    room.fire("participantConnected");
    room.fire("trackSubscribed", audioTrack());
    room.fire("disconnected", DisconnectReason.PARTICIPANT_REMOVED);
    expect(s.state().status).toBe("idle");
    expect(s.state().notice).toBeNull();
    expect(s.sink.tracks.size).toBe(0);
  });

  it("remote audio tracks are attached on subscribe and removed on unsubscribe", async () => {
    const s = await joined();
    const a = audioTrack();
    const video = { kind: "video" } as never;
    s.room().fire("trackSubscribed", a);
    s.room().fire("trackSubscribed", video);
    expect(s.sink.tracks.size).toBe(1);
    s.room().fire("trackUnsubscribed", a);
    expect(s.sink.tracks.size).toBe(0);
  });
});

describe("mic, deafen and camera", () => {
  it("canSpeak=false: the mic is never published, not on join and not on toggle", async () => {
    const s = await joined({ canSpeak: false, canVideo: false });
    expect(s.room().mic).toEqual([]);
    expect(s.state().micEnabled).toBe(false);
    await s.voice.toggleMic();
    await s.voice.toggleCamera();
    expect(s.room().mic).toEqual([]);
    expect(s.room().cam).toEqual([]);
    expect(s.state()).toMatchObject({ micEnabled: false, camEnabled: false });
  });

  it("mute / unmute", async () => {
    const s = await joined();
    await s.voice.toggleMic();
    expect(s.state().micEnabled).toBe(false);
    await s.voice.toggleMic();
    expect(s.state().micEnabled).toBe(true);
    expect(s.room().mic).toEqual([true, false, true]);
  });

  it("deafen mutes all remote audio (no unsubscribe) and the mic; undeafen restores the mic as it was", async () => {
    const s = await joined();
    s.room().fire("trackSubscribed", audioTrack());
    await s.voice.toggleDeafen();
    expect(s.sink.muted).toBe(true);
    expect(s.sink.tracks.size).toBe(1);
    expect(s.state()).toMatchObject({ deafened: true, micEnabled: false, micBeforeDeafen: true });
    await s.voice.toggleMic(); // disabled while deafened
    expect(s.state().micEnabled).toBe(false);
    await s.voice.toggleDeafen();
    expect(s.sink.muted).toBe(false);
    expect(s.state()).toMatchObject({ deafened: false, micEnabled: true });
  });

  it("undeafen leaves a mic that was muted before deafening muted", async () => {
    const s = await joined();
    await s.voice.toggleMic(); // muted
    await s.voice.toggleDeafen();
    await s.voice.toggleDeafen();
    expect(s.state().micEnabled).toBe(false);
    expect(s.room().mic).toEqual([true, false]);
  });

  it("a mic denied by the OS joins muted with a message", async () => {
    const s = setupVoice();
    s.ensureMedia.mockResolvedValue(false);
    await s.voice.joinChannel("c1", "n");
    expect(s.state()).toMatchObject({ status: "connected", micEnabled: false, mediaNote: expect.stringContaining("Cài đặt") });
    expect(s.room().mic).toEqual([]);
  });

  it("a getUserMedia failure joins muted and says why", async () => {
    const s = setupVoice({}, (r) => (r.micFails = true));
    await s.voice.joinChannel("c1", "n");
    expect(s.state()).toMatchObject({ status: "connected", micEnabled: false, mediaNote: expect.stringContaining("micro") });
    expect(s.room().mic).toEqual([]);
  });

  it("a mute clicked while the first publish is still in flight is not lost (changes apply in order)", async () => {
    let open!: () => void;
    const s = setupVoice({}, (r) => (r.micGate = new Promise((res) => (open = res))));
    const joining = s.voice.joinChannel("c1", "n");
    await vi.waitFor(() => expect(s.state().status).toBe("connected"));
    const muting = s.voice.toggleMic(); // the user sees the mic on and clicks mute
    expect(s.state().micEnabled).toBe(false); // intention is visible at once
    open();
    await Promise.all([joining, muting]);
    expect(s.room().mic).toEqual([true, false]);
    expect(s.state().micEnabled).toBe(false);
  });

  it("camera on/off needs canVideo", async () => {
    const s = await joined();
    await s.voice.toggleCamera();
    expect(s.state().camEnabled).toBe(true);
    await s.voice.toggleCamera();
    expect(s.room().cam).toEqual([true, false]);
  });
});

describe("rights changes", () => {
  it("rightsOf reads LiveKit permissions", () => {
    expect(rightsOf({ canPublish: true, canPublishSources: [] })).toEqual({ canSpeak: true, canVideo: true });
    expect(rightsOf({ canPublish: true, canPublishSources: [2] })).toEqual({ canSpeak: true, canVideo: false });
    expect(rightsOf({ canPublish: true, canPublishSources: [1] })).toEqual({ canSpeak: false, canVideo: true });
    expect(rightsOf({ canPublish: false, canPublishSources: [1, 2] })).toEqual({ canSpeak: false, canVideo: false });
    expect(rightsOf(undefined)).toEqual({ canSpeak: false, canVideo: false });
  });

  it("losing SPEAK turns the mic off, disables it and forgets a pending restore; others' changes are ignored", async () => {
    const s = await joined();
    const room = s.room();
    room.fire("participantPermissionsChanged", undefined, { identity: "someone-else" });
    expect(s.state().canSpeak).toBe(true);
    await s.voice.toggleDeafen();
    room.localParticipant.permissions = { canPublish: true, canPublishSources: [1] };
    room.fire("participantPermissionsChanged", undefined, { identity: "me" });
    expect(s.state()).toMatchObject({ canSpeak: false, canVideo: true, micEnabled: false, micBeforeDeafen: false });
    await s.voice.toggleDeafen(); // undeafen
    expect(s.state().micEnabled).toBe(false);
    expect(room.mic).toEqual([true, false]); // never re-published
  });

  it("losing VIDEO turns the camera off", async () => {
    const s = await joined();
    await s.voice.toggleCamera();
    s.room().localParticipant.permissions = { canPublish: true, canPublishSources: [2] };
    s.room().fire("participantPermissionsChanged", undefined, { identity: "me" });
    expect(s.state()).toMatchObject({ canVideo: false, camEnabled: false, canSpeak: true });
  });
});

describe("connection events", () => {
  it("reconnecting / reconnected", async () => {
    const s = await joined();
    s.room().fire("reconnecting");
    expect(s.state().status).toBe("reconnecting");
    s.room().fire("reconnected");
    expect(s.state().status).toBe("connected");
  });

  it.each([
    [DisconnectReason.PARTICIPANT_REMOVED, "channel", "bị đưa ra"],
    [DisconnectReason.DUPLICATE_IDENTITY, "channel", "nơi khác"],
    [DisconnectReason.ROOM_DELETED, "channel", "đã đóng"],
    [DisconnectReason.ROOM_DELETED, "dm", "Cuộc gọi đã kết thúc"],
    [DisconnectReason.SERVER_SHUTDOWN, "channel", "Mất kết nối"],
  ] as const)("forced disconnect %s (%s) -> idle-like state, room released, message", async (reason, kind, text) => {
    const s = setupVoice();
    if (kind === "channel") await s.voice.joinChannel("c1", "n");
    else await s.voice.joinDm("d1", "Lan", false);
    s.room().fire("trackSubscribed", audioTrack());
    s.room().fire("disconnected", reason);
    expect(s.state()).toMatchObject({ status: "disconnected", target: null, participants: [], micEnabled: false });
    expect(s.state().notice).toContain(text);
    expect(s.sink.tracks.size).toBe(0);
    expect(disconnectMessage(reason, kind)).toBe(s.state().notice);
    await s.voice.joinChannel("c2", "m"); // a new join works from here
    expect(s.state().status).toBe("connected");
  });

  it("our own disconnect (client initiated) is not a notice", async () => {
    const s = await joined();
    s.room().fire("disconnected", DisconnectReason.CLIENT_INITIATED);
    expect(s.state().status).toBe("connected");
  });
});

describe("participants and speaking", () => {
  it("the live room lists local first, then remotes, and marks active speakers", async () => {
    const s = await joined();
    s.room().addRemote("u2", "Lan");
    s.room().fire("activeSpeakersChanged", [{ identity: "u2" }]);
    expect(s.state().participants).toMatchObject([
      { userId: "me", isLocal: true, speaking: false },
      { userId: "u2", username: "Lan", isLocal: false, speaking: true },
    ]);
    s.room().fire("activeSpeakersChanged", []);
    expect(s.state().participants.some((p) => p.speaking)).toBe(false);
  });
});
