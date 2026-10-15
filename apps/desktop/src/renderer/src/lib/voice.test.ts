import { DisconnectReason } from "livekit-client";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./auth-client";
import { audioTrack, FakeRoom, setupVoice } from "./voice-fakes";
import { streamProfile, type ShareChoice } from "./golive";
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

const display = (over: Partial<ShareChoice> = {}): ShareChoice => ({ source: { kind: "display", id: "screen:1" }, quality: { resolution: "720", fps: 60 }, audio: true, label: "Màn hình", ...over });
const camera = (over: Partial<ShareChoice> = {}): ShareChoice => ({ source: { kind: "device", deviceId: "cap1" }, quality: { resolution: "1080", fps: 30 }, audio: false, label: "Capture", ...over });

describe("screen share", () => {
  it("picks, checks the OS, captures at the chosen profile and publishes the picture (with the sound) as the screen share; stops again", async () => {
    const s = await joined();
    await s.voice.toggleScreen();
    expect(s.pickScreen).toHaveBeenCalledOnce();
    expect(s.ensureMedia).toHaveBeenCalledWith("screen");
    expect(s.capture).toHaveBeenCalledWith(display(), streamProfile({ resolution: "720", fps: 60 }));
    expect(s.state()).toMatchObject({ screenEnabled: true, mediaNote: null });
    const [video, audio] = s.room().published;
    expect(video.options).toEqual({ source: "screen_share", screenShareEncoding: { maxBitrate: 4_000_000, maxFramerate: 60 }, simulcast: false });
    expect(audio.options).toEqual({ source: "screen_share_audio" });
    await s.voice.toggleScreen();
    expect(s.state().screenEnabled).toBe(false);
    expect(s.room().unpublished).toHaveLength(2);
    expect(s.captured.map((t) => t.stopped)).toEqual([1, 1]);
  });

  it("a camera / capture card asks for camera access and is published as the screen share, without sound", async () => {
    const s = await joined();
    s.pickScreen.mockResolvedValueOnce(camera());
    await s.voice.startScreen();
    expect(s.ensureMedia).toHaveBeenCalledWith("camera");
    expect(s.ensureMedia).not.toHaveBeenCalledWith("screen");
    expect(s.room().published.map((p) => p.options.source)).toEqual(["screen_share"]);
    expect(s.room().published[0].options.screenShareEncoding).toEqual({ maxBitrate: 5_000_000, maxFramerate: 30 });
    expect(s.state().screenEnabled).toBe(true);
    await s.voice.stopScreen();
    expect(s.captured[0].stopped).toBe(1); // the device is released
  });

  it("a camera refused by the OS says so like the camera button and publishes nothing", async () => {
    const s = await joined();
    s.pickScreen.mockResolvedValueOnce(camera());
    s.ensureMedia.mockImplementation(async (k) => k !== "camera");
    await s.voice.startScreen();
    expect(s.state()).toMatchObject({ screenEnabled: false });
    expect(s.state().mediaNote).toContain("camera");
    expect(s.capture).not.toHaveBeenCalled();
  });

  it("changing the source while live stops the old tracks, then publishes the new ones, in the same session", async () => {
    const s = await joined();
    await s.voice.startScreen();
    const room = s.room();
    const before = s.state().sessionId;
    s.pickScreen.mockResolvedValueOnce(camera());
    await s.voice.startScreen();
    expect(s.captured.slice(0, 2).map((t) => t.stopped)).toEqual([1, 1]); // old picture and sound
    expect(room.unpublished).toEqual(s.captured.slice(0, 2));
    expect(room.published.map((p) => p.track)).toEqual(s.captured); // old two, then the camera
    expect(s.captured[2].stopped).toBe(0);
    expect(s.state()).toMatchObject({ status: "connected", screenEnabled: true, sessionId: before });
    expect(s.rooms).toHaveLength(1);
    expect(room.disconnected).toBe(0);
  });

  it("cancelling the dialog while live keeps the running share untouched", async () => {
    const s = await joined();
    await s.voice.startScreen();
    s.pickScreen.mockResolvedValueOnce(null);
    await s.voice.startScreen();
    expect(s.state()).toMatchObject({ screenEnabled: true, mediaNote: null });
    expect(s.room().unpublished).toEqual([]);
    expect(s.captured.map((t) => t.stopped)).toEqual([0, 0]);
    expect(s.capture).toHaveBeenCalledOnce();
  });

  it("a replacement that fails to capture leaves the share off and says so (the old one is already gone)", async () => {
    const s = await joined();
    await s.voice.startScreen();
    s.capture.mockRejectedValueOnce(new Error("NotAllowedError"));
    await s.voice.startScreen();
    expect(s.state()).toMatchObject({ screenEnabled: false });
    expect(s.state().mediaNote).toContain("chia sẻ màn hình");
    expect(s.captured.map((t) => t.stopped)).toEqual([1, 1]);
  });

  describe("changing the live stream", () => {
    const live = (room: FakeRoom) => room.published.filter((p) => !room.unpublished.includes(p.track));
    const started = async () => {
      const s = await joined();
      await s.voice.startScreen();
      return s;
    };

    it("remembers what is live: the source, quality, sound and the name for the panel", async () => {
      const s = await started();
      expect(s.state().stream).toEqual(display());
      await s.voice.stopScreen();
      expect(s.state()).toMatchObject({ screenEnabled: false, stream: null });
    });

    it("quality: captures the SAME source again at the new profile, replaces the old tracks, asks nothing and remembers the choice", async () => {
      const s = await started();
      const room = s.room();
      await s.voice.setStreamQuality({ resolution: "1080", fps: 30 });
      expect(s.pickScreen).toHaveBeenCalledOnce();
      expect(s.ensureMedia.mock.calls.filter(([k]) => k === "screen")).toHaveLength(1); // the OS was asked once, at the start
      expect(s.capture).toHaveBeenLastCalledWith(display({ quality: { resolution: "1080", fps: 30 } }), streamProfile({ resolution: "1080", fps: 30 }));
      expect(live(room).map((p) => p.track)).toEqual(s.captured.slice(2)); // only the new picture and sound
      expect(live(room)[0].options.screenShareEncoding).toEqual({ maxBitrate: 5_000_000, maxFramerate: 30 });
      expect(s.captured.slice(0, 2).map((t) => t.stopped)).toEqual([1, 1]);
      expect(s.captured.slice(2).map((t) => t.stopped)).toEqual([0, 0]);
      expect(s.state()).toMatchObject({ screenEnabled: true, mediaNote: null, stream: { quality: { resolution: "1080", fps: 30 }, audio: true, label: "Màn hình" } });
      expect(s.rememberShare).toHaveBeenCalledWith({ resolution: "1080", fps: 30, audio: true });
      expect(room.disconnected).toBe(0);
    });

    it("sound: turning it off re-captures the same source without sound (one picture, no sound track), and back on", async () => {
      const s = await started();
      const room = s.room();
      await s.voice.setStreamAudio(false);
      expect(s.capture).toHaveBeenLastCalledWith(display({ audio: false }), streamProfile({ resolution: "720", fps: 60 }));
      expect(live(room).map((p) => p.options.source)).toEqual(["screen_share"]);
      expect(s.rememberShare).toHaveBeenLastCalledWith({ resolution: "720", fps: 60, audio: false });
      await s.voice.setStreamAudio(true);
      expect(live(room).map((p) => p.options.source)).toEqual(["screen_share", "screen_share_audio"]);
      expect(s.state().stream?.audio).toBe(true);
      expect(s.pickScreen).toHaveBeenCalledOnce();
    });

    it("the share never reads as stopped while it is being replaced (the old picture's end is not a stop)", async () => {
      const s = await started();
      const seen: boolean[] = [];
      s.voice.store.subscribe((st) => seen.push(st.screenEnabled));
      await s.voice.setStreamQuality({ resolution: "native", fps: 15 });
      expect(seen).not.toContain(false);
      expect(s.state().screenEnabled).toBe(true);
    });

    it("quick changes in a row all apply, in order, on top of each other", async () => {
      const s = await started();
      void s.voice.setStreamQuality({ resolution: "1080", fps: 30 });
      await s.voice.setStreamAudio(false);
      expect(s.state().stream).toMatchObject({ quality: { resolution: "1080", fps: 30 }, audio: false });
      expect(live(s.room())).toHaveLength(1);
    });

    it("changing to what is already live does nothing", async () => {
      const s = await started();
      await s.voice.setStreamQuality({ resolution: "720", fps: 60 });
      await s.voice.setStreamAudio(true);
      expect(s.capture).toHaveBeenCalledOnce();
      expect(s.rememberShare).not.toHaveBeenCalled();
    });

    it("without a running share there is nothing to change", async () => {
      const s = await joined();
      await s.voice.setStreamQuality({ resolution: "1080", fps: 30 });
      await s.voice.setStreamAudio(false);
      expect(s.capture).not.toHaveBeenCalled();
      expect(s.state().screenEnabled).toBe(false);
    });

    it("a camera keeps its device when its quality changes", async () => {
      const s = await joined();
      s.pickScreen.mockResolvedValueOnce(camera());
      await s.voice.startScreen();
      await s.voice.setStreamQuality({ resolution: "720", fps: 60 });
      expect(s.capture).toHaveBeenLastCalledWith(camera({ quality: { resolution: "720", fps: 60 } }), streamProfile({ resolution: "720", fps: 60 }));
      expect(live(s.room())).toHaveLength(1);
    });

    it("a capture that fails leaves the share off, says so, and releases the old tracks", async () => {
      const s = await started();
      s.capture.mockRejectedValueOnce(new Error("NotAllowedError"));
      await s.voice.setStreamQuality({ resolution: "1080", fps: 30 });
      expect(s.state()).toMatchObject({ screenEnabled: false, stream: null });
      expect(s.state().mediaNote).toContain("chia sẻ màn hình");
      expect(live(s.room())).toEqual([]);
    });

    it("changing the source updates the remembered stream", async () => {
      const s = await started();
      s.pickScreen.mockResolvedValueOnce(camera());
      await s.voice.startScreen();
      expect(s.state().stream).toEqual(camera());
    });

    it("losing the right to stream clears it", async () => {
      const s = await started();
      s.room().localParticipant.permissions = { canPublish: true, canPublishSources: [1, 2] };
      s.room().fire("participantPermissionsChanged", {}, { identity: "me" });
      expect(s.state()).toMatchObject({ screenEnabled: false, stream: null });
    });
  });

  it("cancelling the dialog is not an error and publishes nothing", async () => {
    const s = await joined();
    s.pickScreen.mockResolvedValueOnce(null);
    await s.voice.toggleScreen();
    expect(s.state()).toMatchObject({ screenEnabled: false, mediaNote: null });
    expect(s.room().published).toEqual([]);
    expect(s.ensureMedia).not.toHaveBeenCalledWith("screen");
  });

  it("an OS refusal (macOS Screen Recording) shows its message and captures nothing", async () => {
    const s = await joined();
    s.ensureMedia.mockImplementation(async (k) => k !== "screen");
    await s.voice.toggleScreen();
    expect(s.state().screenEnabled).toBe(false);
    expect(s.state().mediaNote).toContain("Ghi màn hình");
    expect(s.capture).not.toHaveBeenCalled();
  });

  it("a publish that fails says so, leaves the button off and releases what was captured", async () => {
    const s = await joined();
    s.room().screenFails = true;
    await s.voice.toggleScreen();
    expect(s.state()).toMatchObject({ screenEnabled: false });
    expect(s.state().mediaNote).toContain("chia sẻ màn hình");
    expect(s.captured.every((t) => t.stopped === 1)).toBe(true);
  });

  it("without canStream it cannot be turned on", async () => {
    const s = await joined({ canStream: false });
    await s.voice.toggleScreen();
    expect(s.state().screenEnabled).toBe(false);
    expect(s.pickScreen).not.toHaveBeenCalled();
    expect(s.room().published).toEqual([]);
  });

  it("the OS 'Stop sharing' (track unpublished) turns the button off and releases the sound track too; a camera track ending does not", async () => {
    const s = await joined();
    await s.voice.toggleScreen();
    s.room().fire("localTrackUnpublished", { source: "camera" });
    expect(s.state().screenEnabled).toBe(true);
    s.room().fire("localTrackUnpublished", { source: "screen_share" });
    expect(s.state().screenEnabled).toBe(false);
    await vi.waitFor(() => expect(s.captured.map((t) => t.stopped)).toEqual([1, 1]));
    expect(s.room().unpublished).toContain(s.captured[1]);
  });

  it("losing STREAM turns the share off and disables the button", async () => {
    const s = await joined();
    await s.voice.toggleScreen();
    s.room().localParticipant.permissions = { canPublish: true, canPublishSources: [1, 2] };
    s.room().fire("participantPermissionsChanged", undefined, { identity: "me" });
    expect(s.state()).toMatchObject({ canStream: false, screenEnabled: false, canSpeak: true });
    expect(s.captured.map((t) => t.stopped)).toEqual([1, 1]);
  });

  it("leaving the room releases the capture", async () => {
    const s = await joined();
    await s.voice.toggleScreen();
    s.voice.leave();
    expect(s.captured.map((t) => t.stopped)).toEqual([1, 1]);
  });

  it("a remote share shows as `screen` (and `sharing`) on its owner; its audio goes to the sink", async () => {
    const s = await joined();
    const video = { attach: () => undefined, detach: () => undefined };
    const room = s.room();
    room.remoteParticipants.set("u2", { identity: "u2", name: "Lan", getTrackPublication: (src: string) => (src === "screen_share" ? { track: video, isMuted: false } : undefined) } as never);
    room.fire("trackPublished");
    expect(s.state().participants.find((p) => p.userId === "u2")).toMatchObject({ sharing: true, screen: video });
    const audio = audioTrack();
    room.fire("trackSubscribed", audio);
    expect(s.sink.tracks.has(audio)).toBe(true);
  });
});

describe("rights changes", () => {
  it("rightsOf reads LiveKit permissions", () => {
    expect(rightsOf({ canPublish: true, canPublishSources: [] })).toEqual({ canSpeak: true, canVideo: true, canStream: true });
    expect(rightsOf({ canPublish: true, canPublishSources: [2] })).toEqual({ canSpeak: true, canVideo: false, canStream: false });
    expect(rightsOf({ canPublish: true, canPublishSources: [1] })).toEqual({ canSpeak: false, canVideo: true, canStream: false });
    expect(rightsOf({ canPublish: true, canPublishSources: [3, 4] })).toEqual({ canSpeak: false, canVideo: false, canStream: true });
    expect(rightsOf({ canPublish: false, canPublishSources: [1, 2, 3] })).toEqual({ canSpeak: false, canVideo: false, canStream: false });
    expect(rightsOf(undefined)).toEqual({ canSpeak: false, canVideo: false, canStream: false });
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

  it("keeps LiveKit's quality rating of OUR connection only, and forgets it on leaving", async () => {
    const s = await joined();
    expect(s.state().quality).toBe("unknown");
    s.room().fire("connectionQualityChanged", "poor", { identity: "me" });
    expect(s.state().quality).toBe("poor");
    s.room().fire("connectionQualityChanged", "excellent", { identity: "someone-else" });
    expect(s.state().quality).toBe("poor");
    await s.voice.leave();
    expect(s.state().quality).toBe("unknown");
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

describe("switchDevice (settings change while in a session)", () => {
  it("moves the live room to the device; with no session it does nothing and does not throw", async () => {
    const idle = setupVoice();
    await expect(idle.voice.switchDevice("audioinput", "m2")).resolves.toBeUndefined();
    const s = await joined();
    await s.voice.switchDevice("audioinput", "m2");
    await s.voice.switchDevice("videoinput", "default");
    expect(s.room().switched).toEqual([["audioinput", "m2"], ["videoinput", "default"]]);
  });
  it("a device that cannot be opened does not break the session", async () => {
    const s = await joined();
    s.room().switchActiveDevice = async () => Promise.reject(new Error("NotFoundError"));
    await expect(s.voice.switchDevice("audioinput", "gone")).resolves.toBeUndefined();
    expect(s.state().status).toBe("connected");
  });
});

describe("what others show", () => {
  const remote = (r: FakeRoom, identity: string, extra: object) => {
    const p = { identity, name: identity, getTrackPublication: () => undefined, ...extra };
    r.remoteParticipants.set(identity, p);
    r.fire("participantConnected", p);
  };
  const of = (s: Awaited<ReturnType<typeof joined>>, id: string) => s.state().participants.find((p) => p.userId === id);

  it("a remote mic that is absent or muted is off; an unmuted one is on; a person who may not speak shows nothing", async () => {
    const s = await joined();
    remote(s.room(), "none", {});
    remote(s.room(), "muted", { getTrackPublication: (k: string) => (k === "microphone" ? { isMuted: true } : undefined) });
    remote(s.room(), "live", { getTrackPublication: (k: string) => (k === "microphone" ? { isMuted: false } : undefined) });
    remote(s.room(), "listener", { permissions: { canPublish: false, canPublishSources: [] } });
    expect([of(s, "none")?.micOff, of(s, "muted")?.micOff, of(s, "live")?.micOff, of(s, "listener")?.micOff]).toEqual([true, true, false, false]);
  });

  it("deafened comes from their metadata, read defensively; our own deafen is published and cleared", async () => {
    const s = await joined();
    remote(s.room(), "deaf", { metadata: '{"deafened":true}' });
    remote(s.room(), "junk", { metadata: "{nope" });
    expect([of(s, "deaf")?.deafened, of(s, "junk")?.deafened]).toEqual([true, false]);
    await s.voice.toggleDeafen();
    await s.voice.toggleDeafen();
    expect(s.room().metadata).toEqual(['{"deafened":true}', ""]);
  });
});

describe("join/leave sounds", () => {
  const kinds = (s: { sounds: [string, boolean][] }) => s.sounds.map(([k]) => k);
  const joinedWith = async (...present: string[]) => {
    const s = setupVoice({}, (r) => present.forEach((id) => r.remoteParticipants.set(id, { identity: id, getTrackPublication: () => undefined })));
    await s.voice.joinChannel("c1", "Phòng họp");
    return s;
  };

  it("our own connect is a selfJoin and the people already there are silent", async () => {
    const s = await joinedWith("a", "b");
    expect(kinds(s)).toEqual(["selfJoin"]);
  });

  it("others joining or leaving afterwards sound once each; a repeated announcement does not", async () => {
    const s = await joinedWith("a");
    s.room().addRemote("n");
    s.room().addRemote("n");
    s.room().removeRemote("a");
    s.room().removeRemote("a");
    expect(kinds(s)).toEqual(["selfJoin", "join", "leave"]);
  });

  it("a reconnect replays nothing: the re-announced people are silent, later changes sound again", async () => {
    const s = await joinedWith("a");
    const r = s.room();
    r.fire("reconnecting");
    r.removeRemote("a");
    r.addRemote("a");
    r.addRemote("z"); // joined during the outage: silent, no one knew
    r.fire("reconnected");
    expect(kinds(s)).toEqual(["selfJoin"]);
    r.addRemote("y");
    expect(kinds(s)).toEqual(["selfJoin", "join"]);
  });

  it("leaving is a selfLeave once; a failed join and an idle leave are silent; a server-forced end is a selfLeave", async () => {
    const s = await joinedWith();
    s.voice.leave();
    s.voice.leave();
    expect(kinds(s)).toEqual(["selfJoin", "selfLeave"]);
    const f = setupVoice({}, (r) => (r.connectError = new Error("x")));
    await f.voice.joinChannel("c1", "x");
    f.voice.leave();
    expect(f.sounds).toEqual([]);
    const g = await joinedWith();
    g.room().fire("disconnected", DisconnectReason.PARTICIPANT_REMOVED);
    expect(kinds(g)).toEqual(["selfJoin", "selfLeave"]);
  });

  it("passes whether we are deafened at that moment (also on our own leave)", async () => {
    const s = await joinedWith();
    await s.voice.toggleDeafen();
    s.room().addRemote("n");
    s.voice.leave();
    expect(s.sounds).toEqual([["selfJoin", false], ["join", true], ["selfLeave", true]]);
  });
});

describe("watching a screen share", () => {
  type Pub = { track?: undefined; isMuted: boolean; isSubscribed: boolean; setSubscribed: ReturnType<typeof vi.fn<(on: boolean) => void>> };
  const pub = (subscribed = true): Pub => {
    const p: Pub = { isMuted: false, isSubscribed: subscribed, setSubscribed: vi.fn() };
    p.setSubscribed.mockImplementation((on) => void (p.isSubscribed = on));
    return p;
  };
  /** A remote who shares a screen (picture + sound) and has a microphone; LiveKit auto-subscribed all of it. */
  const withSharer = async () => {
    const s = await joined();
    const pubs: Record<string, Pub | undefined> = { screen_share: pub(), screen_share_audio: pub(), microphone: pub() };
    const sharer = { identity: "u2", name: "Lan", getTrackPublication: (source: string) => pubs[source] };
    const room = s.room();
    room.remoteParticipants.set("u2", sharer);
    room.fire("participantConnected", sharer);
    return { s, pubs, room, sharer };
  };
  const sound = () => ({ kind: "audio", source: "screen_share_audio", attach: () => document.createElement("audio"), detach: () => undefined }) as never;

  it("is not watched by default: picture and sound are unsubscribed, the microphone is not touched", async () => {
    const { s, pubs } = await withSharer();
    expect(s.state().watching).toEqual([]);
    expect(pubs.screen_share?.setSubscribed).toHaveBeenCalledWith(false);
    expect(pubs.screen_share_audio?.setSubscribed).toHaveBeenCalledWith(false);
    expect(pubs.microphone?.setSubscribed).not.toHaveBeenCalled();
  });

  it("watch subscribes picture and sound; unwatch drops them again", async () => {
    const { s, pubs } = await withSharer();
    s.voice.watch("u2");
    expect(s.state().watching).toEqual(["u2"]);
    expect(pubs.screen_share?.isSubscribed).toBe(true);
    expect(pubs.screen_share_audio?.isSubscribed).toBe(true);
    s.voice.unwatch("u2");
    expect(s.state().watching).toEqual([]);
    expect(pubs.screen_share?.isSubscribed).toBe(false);
    expect(pubs.screen_share_audio?.isSubscribed).toBe(false);
    expect(pubs.microphone?.setSubscribed).not.toHaveBeenCalled();
  });

  it("only someone who is sharing can be watched (not yourself, not a stranger)", async () => {
    const { s } = await withSharer();
    s.voice.watch("me");
    s.voice.watch("nobody");
    expect(s.state().watching).toEqual([]);
  });

  it("the sharer stopping clears the watching state; leaving the room does too", async () => {
    const { s, pubs, room } = await withSharer();
    s.voice.watch("u2");
    pubs.screen_share = undefined;
    room.fire("trackUnpublished");
    expect(s.state().watching).toEqual([]);
    const again = await withSharer();
    again.s.voice.watch("u2");
    again.s.voice.leave();
    expect(again.s.state().watching).toEqual([]);
  });

  it("a sharer that disconnects is no longer watched", async () => {
    const { s, room } = await withSharer();
    s.voice.watch("u2");
    room.removeRemote("u2");
    expect(s.state().watching).toEqual([]);
  });

  it("the stream sound plays at the slider while watched, and the mic is never part of it", async () => {
    const { s, room, sharer } = await withSharer();
    const track = sound();
    s.voice.watch("u2");
    room.fire("trackSubscribed", track, undefined, sharer);
    expect(s.sink.tracks.has(track)).toBe(true);
    expect(s.sink.volumes.get(track)).toBe(1);
    s.voice.setStreamVolume("u2", 0.4);
    expect(s.sink.volumes.get(track)).toBe(0.4);
    s.voice.setStreamVolume("u2", 5);
    expect(s.sink.volumes.get(track)).toBe(1);
    s.voice.setStreamMuted("u2", true);
    expect(s.sink.volumes.get(track)).toBe(0);
    s.voice.setStreamMuted("u2", false);
    s.voice.setStreamVolume("u2", 0.4);
    const mic = audioTrack();
    room.fire("trackSubscribed", mic, undefined, sharer);
    expect(s.sink.volumes.has(mic)).toBe(false);
  });

  it("deafen silences the stream sound and undeafen brings the slider back; the slider survives stop and watch again", async () => {
    const { s, room, sharer } = await withSharer();
    const track = sound();
    s.voice.watch("u2");
    room.fire("trackSubscribed", track, undefined, sharer);
    s.voice.setStreamVolume("u2", 0.3);
    await s.voice.toggleDeafen();
    expect(s.sink.volumes.get(track)).toBe(0);
    await s.voice.toggleDeafen();
    expect(s.sink.volumes.get(track)).toBe(0.3);
    s.voice.unwatch("u2");
    expect(s.sink.volumes.get(track)).toBe(0);
    s.voice.watch("u2");
    expect(s.state().streamVolume.u2).toBe(0.3);
    expect(s.sink.volumes.get(track)).toBe(0.3);
  });
});
