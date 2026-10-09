import { io, type Socket } from "socket.io-client";
import { expect, vi } from "vitest";
import type { buildApp } from "../src/app.js";

export type Client = Socket & { got: Record<string, any[]> };

export async function listen(app: ReturnType<typeof buildApp>) {
  await app.listen({ port: 0, host: "127.0.0.1" });
  return (app.server.address() as { port: number }).port;
}

/** Connected socket that records every event in `events` it receives into `got[event]`. */
export async function connect(port: number, token: string, events: string[], sockets: Socket[]): Promise<Client> {
  const s = io(`http://127.0.0.1:${port}`, { auth: { token }, reconnection: false, forceNew: true }) as Client;
  s.got = Object.fromEntries(events.map((e) => [e, []]));
  for (const event of events) s.on(event, (p) => s.got[event]!.push(p));
  sockets.push(s);
  await new Promise<void>((resolve, reject) => {
    s.once("connect", resolve);
    s.once("connect_error", reject);
  });
  return s;
}

export const until = (check: () => unknown) => vi.waitFor(() => expect(check()).toBeTruthy(), { timeout: 3000, interval: 10 });
export const settle = () => new Promise((r) => setTimeout(r, 150)); // for "nothing arrives" assertions
