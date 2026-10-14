import type { Channel } from "@loop/shared";

export type Guild = { id: string; name: string; ownerId: string };
export type Category = { id: string; position: number };
export type Author = { id: string; username: string; isBot: boolean };
export type Message = { id: string; channelId: string | null; content: string; createdAt: string; author: Author };
export type VoiceToken = { token: string; url: string; canSpeak: boolean };

/** A non-2xx answer; `status` 0 = the server could not be reached. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Display order of the desktop: uncategorised channels first, then categories by position, each by position. */
export function inDisplayOrder(channels: Channel[], categories: Category[]): Channel[] {
  const rank = new Map(categories.map((c) => [c.id, c.position]));
  const area = (c: Channel) => (c.categoryId === null ? -1 : (rank.get(c.categoryId) ?? -1));
  return [...channels].sort((a, b) => area(a) - area(b) || a.position - b.position);
}

/** REST client of one bot: logs in on first use, and once more when a request is answered 401. */
export class Api {
  accessToken = "";
  userId = "";

  constructor(
    private readonly apiUrl: string,
    private readonly botToken: string,
  ) {}

  async login() {
    const { user, accessToken } = await this.send<{ user: { id: string }; accessToken: string }>("POST", "/auth/bot-login", { token: this.botToken });
    this.userId = user.id;
    this.accessToken = accessToken;
  }

  async request<T>(method: string, path: string, body?: object): Promise<T> {
    if (!this.accessToken) await this.login();
    try {
      return await this.send<T>(method, path, body, this.accessToken);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      await this.login();
      return this.send<T>(method, path, body, this.accessToken);
    }
  }

  private async send<T>(method: string, path: string, body?: object, accessToken?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.apiUrl + path, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(0, `Cannot reach ${this.apiUrl}: ${(e as Error).message}`);
    }
    const text = await res.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return undefined; } })() : undefined;
    if (!res.ok) throw new ApiError(res.status, json?.error ?? res.statusText);
    return json as T;
  }

  sendMessage = (channelId: string, content: string) => this.request<Message>("POST", `/channels/${channelId}/messages`, { content });
  voiceParticipants = (channelId: string) => this.request<{ participants: { userId: string; username: string }[] }>("GET", `/channels/${channelId}/voice`).then((r) => r.participants);
  listGuilds = () => this.request<Guild[]>("GET", "/guilds");
  voiceToken = (channelId: string) => this.request<VoiceToken>("POST", `/channels/${channelId}/voice/token`);

  /** Channels the bot can see, in display order. */
  async listChannels(guildId: string) {
    const { channels, categories } = await this.request<{ channels: Channel[]; categories: Category[] }>("GET", `/guilds/${guildId}`);
    return inDisplayOrder(channels, categories);
  }
}
