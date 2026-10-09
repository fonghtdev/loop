import type { buildApp } from "../src/app.js";
import { prisma } from "../src/db.js";

export const env = { databaseUrl: "", jwtSecret: "test-secret-test-secret-test-secret-1234", port: 0 };

type App = ReturnType<typeof buildApp>;
type Method = "GET" | "POST" | "PATCH" | "DELETE";

export const caller = (app: App) => (method: Method, url: string, token?: string, payload?: object) =>
  app.inject({ method, url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });

export const signUp = async (app: App, name: string) => {
  const body = (
    await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: `${name}@example.com`, username: name, password: "correct-horse" },
    })
  ).json();
  return { token: body.accessToken as string, id: body.user.id as string };
};

export const resetDb = () =>
  prisma.$executeRaw`TRUNCATE "Message", "Invite", "Member", "Channel", "Guild", "Session", "User" CASCADE`;
