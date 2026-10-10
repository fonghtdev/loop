import type { LoopApi } from "../../../preload/api";

export type User = { id: string; email: string; username: string };
type Tokens = { user: User; accessToken: string; refreshToken: string };
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A failed call: HTTP `status` (0 = the server could not be reached) plus the server's `error` text, if any. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly serverMessage?: string,
  ) {
    super(`${status} ${path}${serverMessage ? `: ${serverMessage}` : ""}`);
  }
}

type Deps = {
  baseUrl: string;
  storage: LoopApi["session"];
  /** The session is over (refresh rejected, logout): the app goes back to the login screen. */
  onSignedOut: () => void;
  fetch?: typeof fetch;
};

/**
 * REST client + session. The access token lives only in this closure (memory). The refresh token lives in the
 * main process (encrypted on disk when possible) and is read from there for each refresh.
 *
 * Refresh is single-flight, and that is load-bearing: the server rotates refresh tokens and treats a second use
 * of a rotated one as theft, revoking EVERY session of the user. So all concurrent 401s share one refresh, the
 * new refresh token is persisted before the refresh resolves (nothing can read the old one afterwards), and a
 * request is retried at most once. Auth endpoints never go through the refresh path.
 * Refresh happens on a 401 only (no timer): simpler, and costs one extra round trip every 15 minutes at most.
 */
export function createAuthClient({ baseUrl, storage, onSignedOut, fetch: doFetch = (...a) => fetch(...a) }: Deps) {
  let access: string | null = null;
  let refreshing: Promise<User | null> | null = null;

  async function send(method: Method, path: string, body?: unknown, token = access): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      return await doFetch(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, path);
    }
  }

  async function read<T>(res: Response, path: string): Promise<T> {
    const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    if (!res.ok) throw new ApiError(res.status, path, (data as { error?: string } | undefined)?.error);
    return data as T;
  }

  async function signIn(tokens: Tokens) {
    await storage.set(tokens.refreshToken); // persisted before anyone can use the session
    access = tokens.accessToken;
    return tokens.user;
  }

  async function signOut() {
    access = null;
    await storage.clear();
    onSignedOut();
  }

  /** Resolves to the user, or null when the server rejected the refresh token (session cleared). */
  function refresh(): Promise<User | null> {
    refreshing ??= (async () => {
      try {
        const { token } = await storage.get();
        if (!token) return null;
        const res = await send("POST", "/auth/refresh", { refreshToken: token }, null);
        // Unreachable (send throws), 5xx or 429: keep the stored token, being offline is not being signed out.
        if (res.status >= 500 || res.status === 429) await read(res, "/auth/refresh");
        if (!res.ok) {
          await signOut();
          return null;
        }
        return await signIn(await read<Tokens>(res, "/auth/refresh"));
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** Authenticated API call; one refresh + one retry on 401. */
  async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const sentWith = access;
    let res = await send(method, path, body);
    if (res.status === 401) {
      // A refresh that finished while this request was in flight already gave us a new token: just retry.
      const fresh = (access !== null && access !== sentWith) || (await refresh()) !== null;
      if (!fresh) throw new ApiError(401, path);
      res = await send(method, path, body);
      if (res.status === 401) await signOut(); // a brand-new token rejected: the session is gone, do not loop
    }
    return read<T>(res, path);
  }

  /**
   * Access token for the socket handshake: the current one, or a fresh one from the SAME single-flight refresh
   * when there is none or `rejected` (what the server just refused) is still the current one. null = signed out.
   */
  async function accessToken(rejected?: string): Promise<string | null> {
    if (access !== null && access !== rejected) return access;
    return (await refresh()) ? access : null;
  }

  return {
    request,
    accessToken,
    /** Startup: the stored session's user, or null when there is none (or it was rejected). Throws when offline. */
    restore: refresh,
    login: async (body: { email: string; password: string }) =>
      signIn(await read<Tokens>(await send("POST", "/auth/login", body, null), "/auth/login")),
    register: async (body: { email: string; username: string; password: string }) =>
      signIn(await read<Tokens>(await send("POST", "/auth/register", body, null), "/auth/register")),
    /** Best effort on the server; always clears locally. */
    async logout() {
      const { token } = await storage.get();
      if (token) await send("POST", "/auth/logout", { refreshToken: token }, null).catch(() => {});
      await signOut();
    },
  };
}

export type AuthClient = ReturnType<typeof createAuthClient>;
