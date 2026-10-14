import { describe, expect, it, vi } from "vitest";
import type { SoundKind } from "./sounds";
import { createShortcutHandler } from "./shortcut-handler";
import { setupVoice } from "./voice-fakes";

async function setup(token = {}, join = true) {
  const s = setupVoice(token);
  if (join) await s.voice.joinChannel("c1", "Phòng");
  const beeps: SoundKind[] = [];
  return { ...s, beeps, press: createShortcutHandler(s.voice, (k) => beeps.push(k)) };
}

describe("global shortcut handler", () => {
  it("outside a session it does nothing and stays silent", async () => {
    const s = await setup({}, false);
    await s.press("mic");
    await s.press("deafen");
    expect(s.state()).toMatchObject({ micEnabled: false, deafened: false });
    expect(s.beeps).toEqual([]);
  });

  it.each(["requestingToken", "connecting", "reconnecting", "disconnected"])("while %s it does not touch the session", async (status) => {
    const voice = { store: { getState: () => ({ status, micEnabled: true, deafened: false }) }, toggleMic: vi.fn(), toggleDeafen: vi.fn() };
    await createShortcutHandler(voice as never, vi.fn())("mic");
    await createShortcutHandler(voice as never, vi.fn())("deafen");
    expect(voice.toggleMic).not.toHaveBeenCalled();
    expect(voice.toggleDeafen).not.toHaveBeenCalled();
  });

  it("mic: toggles through the voice session and beeps by the new state", async () => {
    const s = await setup();
    await s.press("mic");
    expect(s.state().micEnabled).toBe(false);
    await s.press("mic");
    expect(s.state().micEnabled).toBe(true);
    expect(s.room().mic).toEqual([true, false, true]);
    expect(s.beeps).toEqual(["mute", "unmute"]);
  });

  it("no right to speak: the mic stays off and nothing beeps", async () => {
    const s = await setup({ canSpeak: false });
    await s.press("mic");
    expect(s.state().micEnabled).toBe(false);
    expect(s.room().mic).toEqual([]);
    expect(s.beeps).toEqual([]);
  });

  it("deafen: deafens (mic off too) with the off beep, undeafen restores with the on beep", async () => {
    const s = await setup();
    await s.press("deafen");
    expect(s.state()).toMatchObject({ deafened: true, micEnabled: false });
    await s.press("deafen");
    expect(s.state()).toMatchObject({ deafened: false, micEnabled: true });
    expect(s.beeps).toEqual(["mute", "unmute"]);
  });

  it("the mic shortcut while deafened is refused by the voice rule: no change, no beep", async () => {
    const s = await setup();
    await s.press("deafen");
    s.beeps.length = 0;
    await s.press("mic");
    expect(s.state().micEnabled).toBe(false);
    expect(s.beeps).toEqual([]);
  });

  it("a mic the OS denies ends up off and does not beep as if it turned on", async () => {
    const s = await setup();
    await s.press("mic"); // off
    s.ensureMedia.mockResolvedValueOnce(false);
    s.beeps.length = 0;
    await s.press("mic"); // tries on, OS says no
    expect(s.state().micEnabled).toBe(false);
    expect(s.beeps).toEqual([]);
  });
});
