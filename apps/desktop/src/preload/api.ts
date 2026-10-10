/** Everything the renderer can ask of the main process. Nothing else crosses the bridge. */
export type LoopApi = {
  session: {
    /** `persistent` is false when the OS offers no encryption: the token then lives only until quit. */
    get(): Promise<{ token: string | null; persistent: boolean }>;
    set(token: string): Promise<void>;
    clear(): Promise<void>;
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
