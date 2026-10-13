import type { NotifyPayload } from "../shared/notify";
import type { Settings } from "../shared/settings";
import type { UpdateStatus } from "../shared/update";

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
  settings: {
    get(): Promise<Settings>;
    /** Known boolean keys only; rejects on an invalid patch. Resolves to the settings now in force. */
    set(patch: Partial<Settings>): Promise<Settings>;
  };
  update: {
    get(): Promise<UpdateStatus>;
    /** Starts a check when one makes sense; resolves to the status now in force. */
    check(): Promise<UpdateStatus>;
    /** Quit and install; only acts once an update is downloaded. */
    install(): Promise<void>;
    /** Status changes pushed by the main process (already validated); returns the unsubscribe. */
    onStatus(cb: (status: UpdateStatus) => void): () => void;
  };
  /** Asks the main process for an OS notification (it validates, redacts and respects the settings). */
  notify(payload: NotifyPayload): Promise<void>;
  /** Closes the notification of a conversation / call key (a call that was answered, declined or ended). */
  closeNotification(key: string): Promise<void>;
  /** A clicked notification wants this conversation open (key already validated); returns the unsubscribe. */
  onNavigate(cb: (key: string) => void): () => void;
  /** The unread total for the dock (macOS) / launcher; 0 clears it. */
  setBadge(count: number): Promise<void>;
  /** Whether the window is focused and on screen (pushed by the main process); returns the unsubscribe. */
  onFocusChange(cb: (focused: boolean) => void): () => void;
  /**
   * Removes Loop and its data from THIS computer (the account and server data stay). The main process shows its own native
   * confirmation; "cancelled" = the user said no. On "done" the app is already gone, so this normally never resolves.
   */
  uninstall(): Promise<"done" | "cancelled" | "refused" | "unsupported">;
  openExternal(url: string): Promise<void>;
  version(): Promise<string>;
  platform: string;
  /** True only in an e2e run (LOOP_E2E=1): the renderer may then expose test counters. */
  e2e: boolean;
};

declare global {
  interface Window {
    loop: LoopApi;
  }
}
