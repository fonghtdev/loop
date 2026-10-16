/** Whether push-to-talk can work on this machine: the key hook loaded and (macOS) the OS lets us listen to the keyboard. */
export type PttStatus = "ready" | "unavailable" | "permission";
export const isPttStatus = (v: unknown): v is PttStatus => v === "ready" || v === "unavailable" || v === "permission";
