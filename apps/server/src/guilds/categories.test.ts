import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { categorySchema, channelSchema } from "@loop/shared";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { prisma } from "../db.js";
import { caller, env, signUp } from "../../test/helpers.js";

const app = buildApp(env);
const call = caller(app);

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE "Invite", "Member", "Channel", "Guild", "Session", "User" CASCADE`;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const newGuild = async () => {
  const owner = await signUp(app, "owner");
  const body = (await call("POST", "/guilds", owner.token, { name: "Loop HQ" })).json();
  return { owner, ...body };
};

describe("categories: guild creation and payloads", () => {
  it("a new guild has the two default categories with #general inside the text one", async () => {
    const { categories, channels } = await newGuild();
    expect(categories.map((c: { name: string; position: number }) => [c.name, c.position])).toEqual([
      ["Kênh văn bản", 0],
      ["Kênh thoại", 1],
    ]);
    expect(channels).toHaveLength(1);
    expect(channels[0].categoryId).toBe(categories[0].id);
  });

  it("GET /guilds/:id returns categories sorted by position and channel.categoryId; shapes match the shared schemas", async () => {
    const { owner, guild, categories } = await newGuild();
    // reverse positions so sorting is observable
    await prisma.category.update({ where: { id: categories[0].id }, data: { position: 5 } });
    const res = (await call("GET", `/guilds/${guild.id}`, owner.token)).json();
    expect(res.categories.map((c: { name: string }) => c.name)).toEqual(["Kênh thoại", "Kênh văn bản"]);
    for (const c of res.categories) expect(categorySchema.safeParse(c).success).toBe(true);
    for (const c of res.channels) expect(channelSchema.safeParse(c).success).toBe(true);
    expect(res.channels[0].categoryId).toBe(categories[0].id);
  });

  it("POST channel stays uncategorised and numbers its position within the uncategorised area", async () => {
    const { owner, guild } = await newGuild();
    const a = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "a", type: "TEXT" })).json();
    const b = (await call("POST", `/guilds/${guild.id}/channels`, owner.token, { name: "b", type: "VOICE" })).json();
    expect([a.categoryId, a.position, b.categoryId, b.position]).toEqual([null, 0, null, 1]);
  });
});

describe("categories: database constraints", () => {
  it("deleting a category uncategorises its channels, keeping them and their guildId", async () => {
    const { guild, categories, channels } = await newGuild();
    await prisma.category.delete({ where: { id: categories[0].id } });
    const channel = await prisma.channel.findUniqueOrThrow({ where: { id: channels[0].id } });
    expect(channel.categoryId).toBeNull();
    expect(channel.guildId).toBe(guild.id);
  });

  it("a channel cannot point at a category of another guild", async () => {
    const { guild, channels } = await newGuild();
    const other = await prisma.guild.create({
      data: { name: "other", ownerId: guild.ownerId, categories: { create: { name: "x", position: 0 } } },
      include: { categories: true },
    });
    await expect(
      prisma.channel.update({ where: { id: channels[0].id }, data: { categoryId: other.categories[0].id } }),
    ).rejects.toThrow();
  });
});

describe("categories migration backfill", () => {
  const MIGRATION = "20261013000000_categories";

  it("gives existing guilds both categories and files each channel by type, renumbered by old position", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loop-mig-"));
    const admin = new PrismaClient();
    const dbName = `loop_mig_${process.pid}`;
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = `/${dbName}`;
    const dbUrl = url.toString();
    const run = (cmd: string, input?: string) =>
      execSync(`pnpm exec prisma ${cmd}`, { env: { ...process.env, DATABASE_URL: dbUrl }, input, stdio: ["pipe", "pipe", "pipe"] });
    let db: PrismaClient | undefined;
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.$executeRawUnsafe(`CREATE DATABASE ${dbName}`);
      cpSync("prisma", join(dir, "prisma"), { recursive: true });
      rmSync(join(dir, "prisma/migrations", MIGRATION), { recursive: true });
      run(`migrate deploy --schema ${join(dir, "prisma/schema.prisma")}`);

      run(
        `db execute --stdin --schema ${join(dir, "prisma/schema.prisma")}`,
        `INSERT INTO "User" (id, email, username, "passwordHash") VALUES ('00000000-0000-0000-0000-0000000000a1', 'a@x.io', 'a', 'h');
         INSERT INTO "Guild" (id, name, "ownerId") VALUES ('00000000-0000-0000-0000-0000000000b1', 'g1', '00000000-0000-0000-0000-0000000000a1'),
                                                           ('00000000-0000-0000-0000-0000000000b2', 'g2', '00000000-0000-0000-0000-0000000000a1');
         INSERT INTO "Channel" (id, "guildId", name, type, position, "createdAt") VALUES
           ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1', 'general', 'TEXT', 0, now()),
           ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b1', 'lounge', 'VOICE', 1, now()),
           ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000b1', 'news', 'TEXT', 4, now()),
           ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000b1', 'music', 'VOICE', 7, now()),
           ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000b2', 'general', 'TEXT', 0, now());`,
      );

      cpSync(join("prisma/migrations", MIGRATION), join(dir, "prisma/migrations", MIGRATION), { recursive: true });
      run(`migrate deploy --schema ${join(dir, "prisma/schema.prisma")}`);

      db = new PrismaClient({ datasourceUrl: dbUrl });
      const cats = await db.category.findMany({ orderBy: [{ guildId: "asc" }, { position: "asc" }] });
      expect(cats.map((c) => [c.guildId.slice(-2), c.name, c.position])).toEqual([
        ["b1", "Kênh văn bản", 0],
        ["b1", "Kênh thoại", 1],
        ["b2", "Kênh văn bản", 0],
        ["b2", "Kênh thoại", 1],
      ]);
      const name = (id: string) => cats.find((c) => c.id === id)?.name;
      const channels = await db.channel.findMany({ orderBy: { name: "asc" } });
      expect(channels.map((c) => [c.guildId.slice(-2), c.name, name(c.categoryId!), c.position])).toEqual([
        ["b1", "general", "Kênh văn bản", 0],
        ["b2", "general", "Kênh văn bản", 0],
        ["b1", "lounge", "Kênh thoại", 0],
        ["b1", "music", "Kênh thoại", 1],
        ["b1", "news", "Kênh văn bản", 1],
      ]);
    } finally {
      await db?.$disconnect();
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
