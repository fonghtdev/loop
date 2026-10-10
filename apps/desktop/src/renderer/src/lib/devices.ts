import { createStore } from "zustand/vanilla";

export type DeviceKind = "audioinput" | "audiooutput" | "videoinput";
export const DEVICE_KINDS: DeviceKind[] = ["audioinput", "audiooutput", "videoinput"];
export type Choices = Partial<Record<DeviceKind, string>>;
export type DeviceInfo = { kind: string; deviceId: string; label: string };
export type DeviceOption = { id: string; label: string };

const MAX_ID = 512;

/** The stored choices back into shape; anything unexpected is "default". */
export function parseChoices(raw: string | null): Choices {
  try {
    const v = JSON.parse(raw ?? "null");
    const out: Choices = {};
    if (v && typeof v === "object") for (const k of DEVICE_KINDS) if (typeof v[k] === "string" && v[k] && v[k].length <= MAX_ID) out[k] = v[k];
    return out;
  } catch {
    return {};
  }
}

/** The pickable devices of a kind. The browser's virtual "default"/"communications" entries are the "system default" option instead. */
export function optionsFor(devices: DeviceInfo[], kind: DeviceKind, fallbackName: string): DeviceOption[] {
  return devices
    .filter((d) => d.kind === kind && d.deviceId !== "" && d.deviceId !== "default" && d.deviceId !== "communications")
    .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallbackName} ${i + 1}` }));
}

/** Labels (and ids) stay empty until the page has been granted microphone or camera access. */
export const labelsAvailable = (devices: DeviceInfo[]) => devices.some((d) => d.label !== "");

/**
 * The device to really use for a kind: the chosen one while it exists, else undefined = the system default.
 * Before access is granted the ids are hidden, so a stored choice cannot be checked yet and is kept.
 */
export function effectiveChoice(choice: string | undefined, devices: DeviceInfo[], kind: DeviceKind): string | undefined {
  if (!choice) return undefined;
  const ofKind = devices.filter((d) => d.kind === kind);
  if (!ofKind.some((d) => d.deviceId !== "")) return choice;
  return ofKind.some((d) => d.deviceId === choice) ? choice : undefined;
}

type Deps = {
  storage: { read(): string | null; write(value: string): void };
  enumerate: () => Promise<DeviceInfo[]>;
  /** A kind's effective device changed (a choice, or the chosen device came/went); undefined = system default. */
  apply: (kind: DeviceKind, deviceId: string | undefined) => void;
};

/** The user's microphone / speaker / camera choice, the live device list, and keeping the app on the right ones. */
export function createDevices({ storage, enumerate, apply }: Deps) {
  const store = createStore<{ choices: Choices; devices: DeviceInfo[] }>(() => {
    let raw: string | null = null;
    try {
      raw = storage.read();
    } catch {
      // storage unavailable: defaults
    }
    return { choices: parseChoices(raw), devices: [] };
  });
  const applied: Partial<Record<DeviceKind, string | undefined>> = {};
  let first = true;

  const effective = (kind: DeviceKind) => effectiveChoice(store.getState().choices[kind], store.getState().devices, kind);
  /** Tells `apply` about every kind whose effective device differs from what was last applied. */
  function sync() {
    for (const kind of DEVICE_KINDS) {
      const now = effective(kind);
      if (!first && applied[kind] === now) continue;
      applied[kind] = now;
      apply(kind, now);
    }
    first = false;
  }
  async function refresh() {
    try {
      store.setState({ devices: await enumerate() });
    } catch {
      store.setState({ devices: [] });
    }
    sync();
  }

  return {
    store,
    effective,
    refresh,
    /** null = back to the system default. */
    choose(kind: DeviceKind, deviceId: string | null) {
      const choices = { ...store.getState().choices };
      if (deviceId) choices[kind] = deviceId;
      else delete choices[kind];
      store.setState({ choices });
      try {
        storage.write(JSON.stringify(choices));
      } catch {
        // a lost preference is harmless
      }
      sync();
    },
  };
}
