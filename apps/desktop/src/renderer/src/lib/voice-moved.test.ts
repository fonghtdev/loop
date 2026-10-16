import { describe, expect, it, vi } from "vitest";
import { createVoiceMoved } from "./voice-moved";
import { setupVoice } from "./voice-fakes";

const CHANNELS = [
  { id: "c1", name: "Phòng 1", type: "VOICE" as const },
  { id: "c2", name: "Phòng 2", type: "VOICE" as const },
  { id: "t1", name: "chung", type: "TEXT" as const },
];

function setup() {
  const s = setupVoice();
  const notify = vi.fn();
  const channelsOf = vi.fn(async (_guildId: string) => CHANNELS as typeof CHANNELS | undefined);
  const moved = createVoiceMoved({ voice: s.voice, channelsOf, notify });
  return { ...s, notify, channelsOf, moved };
}

describe("voice:moved", () => {
  it("ignored without a session: nothing is joined, nothing is shown", async () => {
    const s = setup();
    await s.moved({ channelId: "c2", byName: "mod" });
    expect(s.rooms).toHaveLength(0);
    expect(s.notify).not.toHaveBeenCalled();
    expect(s.channelsOf).not.toHaveBeenCalled();
  });

  it("ignored in a DM call (only a server's voice channel is moved)", async () => {
    const s = setup();
    await s.voice.joinDm("d1", "Lan", false);
    await s.moved({ channelId: "c2", byName: "mod" });
    expect(s.state().target).toMatchObject({ kind: "dm", id: "d1" });
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("ignored for the channel we are already in: no second join, no notice", async () => {
    const s = setup();
    await s.voice.joinChannel("c1", "Phòng 1", "g");
    await s.moved({ channelId: "c1", byName: "mod" });
    expect(s.rooms).toHaveLength(1);
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("rejoins the other channel of the same server and says who moved us", async () => {
    const s = setup();
    await s.voice.joinChannel("c1", "Phòng 1", "g");
    await s.moved({ channelId: "c2", byName: "mod" });
    expect(s.channelsOf).toHaveBeenCalledWith("g");
    expect(s.state()).toMatchObject({ status: "connected", target: { kind: "channel", id: "c2", name: "Phòng 2", guildId: "g" } });
    expect(s.rooms).toHaveLength(2);
    expect(s.notify).toHaveBeenCalledWith("mod đã chuyển bạn sang Phòng 2");
  });

  it("a repeat of the same event after the move changes nothing (it cannot loop)", async () => {
    const s = setup();
    await s.voice.joinChannel("c1", "Phòng 1", "g");
    await s.moved({ channelId: "c2", byName: "mod" });
    await s.moved({ channelId: "c2", byName: "mod" });
    expect(s.rooms).toHaveLength(2);
    expect(s.notify).toHaveBeenCalledTimes(1);
  });

  it("ignored for an unknown channel or a text channel", async () => {
    const s = setup();
    await s.voice.joinChannel("c1", "Phòng 1", "g");
    await s.moved({ channelId: "nope", byName: "mod" });
    await s.moved({ channelId: "t1", byName: "mod" });
    expect(s.state().target?.id).toBe("c1");
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("ignored when the channel list is unavailable", async () => {
    const s = setup();
    s.channelsOf.mockResolvedValueOnce(undefined);
    await s.voice.joinChannel("c1", "Phòng 1", "g");
    await s.moved({ channelId: "c2", byName: "mod" });
    expect(s.state().target?.id).toBe("c1");
  });

  it("dropped when we left while the channel list was loading", async () => {
    const s = setup();
    await s.voice.joinChannel("c1", "Phòng 1", "g");
    const pending = s.moved({ channelId: "c2", byName: "mod" });
    s.voice.leave();
    await pending;
    expect(s.state().status).toBe("idle");
    expect(s.notify).not.toHaveBeenCalled();
  });
});
