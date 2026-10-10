/** Everything the renderer can ask of the main process. Nothing else crosses the bridge. */
export type LoopApi = {
  session: {
    /** `persistent` is false when the OS offers no encryption: the token then lives only until quit. */
    get(): Promise<{ token: string | null; persistent: boolean }>;
    set(token: string): Promise<void>;
    clear(): Promise<void>;
  };
  media: {
    /** Asks the OS for microphone/camera access (macOS prompts once; elsewhere true). false = denied in System Settings. */
    ensureAccess(kind: "microphone" | "camera"): Promise<boolean>;
  };
  openExternal(url: string): Promise<void>;
  version(): Promise<string>;
  platform: string;
};

declare global {
  interface Window {
    loop: LoopApi;
  }
}
