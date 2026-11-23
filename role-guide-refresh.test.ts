import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { guideFlags } from "./guide-configuration.ts";
import { createRoleGuides } from "./role-guides.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
const image = (label: string) => Buffer.concat([png, Buffer.from(label)]);
const reply = (label: string) => ({ type: "image" as const, file: image(label) });
const minute = 60_000;
const day = 24 * 60 * minute;

const entries = [
  { id: "1", gid: "2", name: "钟离", command: "#钟离一图流", path: "作者/钟离.jpg" },
  { id: "2", gid: "2", name: "流萤", command: "#星铁流萤一图流", path: "星穹中心/StarRail/流萤.jpg" },
  { id: "3", gid: "2", name: "艾莲", command: "#绝区零艾莲一图流", path: "收藏/ZenlessZoneZero/艾莲.jpg" },
  { id: "341523", gid: "2", name: "珊瑚宫心海", command: "#心海攻略4",
    path: "numbered/4/珊瑚宫心海.jpg", legacy: "oldStrategies/4/珊瑚宫心海.jpg" },
  { id: "2727116", gid: "8", name: "艾莲", command: "%艾莲攻略2",
    path: "numbered/ZenlessZoneZero/清茶沐沐Kiyotya/role_guide_艾莲.png",
    legacy: "oldZzz/images/guides/清茶沐沐Kiyotya/role_guide_艾莲.png" },
] as const;

async function runFixture(use: (fixture: Awaited<ReturnType<typeof prepare>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-role-guide-refresh-"));
  try {
    await use(await prepare(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function prepare(root: string) {
  const cache = join(root, "cache");
  const clock = { now: Date.now(), offline: false, offlineImage: false, revision: 1 };
  const requests: string[] = [];
  const downloads: string[] = [];
  const fetch = (async (target: URL, init: RequestInit) => {
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    const url = new URL(target);
    if (url.hostname === "bbs-api.mihoyo.com") {
      const id = url.searchParams.get("collection_id");
      const row = entries.find(entry => entry.id === id);
      if (!row) throw new Error("Unexpected collection " + id);
      expect(url.searchParams.get("gids")).toBe(row.gid);
      requests.push(row.id);
      if (clock.offline) return new Response(null, { status: 503 });
      const subject = `【角色攻略】${row.name}`;
      const post = row.id === "341523" ? {
        subject, structured_content: `[{"insert":"${row.name}】"},{"insert":{"image":"official"}}]`,
      } : { subject };
      return Response.json({ retcode: 0, data: { posts: [{ post,
        image_list: [{ image_id: "official", size: 100,
          url: `https://upload-bbs.miyoushe.com/${row.id}-${clock.revision}.png` }],
      }] } });
    }
    expect(url.hostname).toBe("upload-bbs.miyoushe.com");
    if (/^\/(?:341523|2727116)-/u.test(url.pathname)) expect(url.searchParams.get("x-oss-process")).toContain("format,jpg");
    else expect(url.searchParams.has("x-oss-process")).toBe(false);
    downloads.push(url.pathname);
    if (clock.offlineImage) return new Response(null, { status: 503 });
    return new Response(image(url.pathname));
  }) as typeof globalThis.fetch;

  async function put(path: string, content: Buffer | string) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    return file;
  }
  async function makeStale(path: string) {
    const old = new Date(clock.now - day - minute);
    await utimes(join(cache, path), old, old);
  }

  await put("config/roleGuides.yaml", "news: [{source: 作者, collection_id: [1]}]\nolds: []\n");
  await put("config/srRoleGuides.yaml", "- {source: 星穹中心, collection_id: [2]}\n");
  await put("config/zzzRoleGuides.yaml", "- {source: 收藏, collection_id: [3]}\n");
  for (const entry of entries) {
    if ("legacy" in entry) await put(entry.legacy, image(`old-${entry.id}`));
    else {
      await put(join("cache", entry.path), image(`old-${entry.id}`));
      await makeStale(entry.path);
    }
  }
  for (const path of ["Genshin/钟离", "StarRail/流萤", "ZenlessZoneZero/艾莲"]) {
    await put(`cache/mora/${path}/index.json`, JSON.stringify({ checkedAt: Date.now(), files: [] }));
  }
  const gitRoot = join(root, "upstream");
  await mkdir(gitRoot);
  for (const args of [
    ["init", "--quiet", "--initial-branch=master", "--template="],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "无 Git 攻略图"],
  ]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: gitRoot, stderr: "pipe" });
    if (result.exitCode) throw new Error(result.stderr.toString());
  }
  return {
    root, cache, clock, requests, downloads, makeStale,
    search(automatic: boolean) {
      return createRoleGuides({ cache, config: join(root, "config"), legacyStrategies: [join(root, "oldStrategies")],
        legacyZzzResources: join(root, "oldZzz"), guideAutomatic: guideFlags({ auto_update: automatic }).auto_update,
        guideSource: pathToFileURL(gitRoot).href, now: () => clock.now, fetch });
    },
  };
}

test("自动更新开关作用于三游综合攻略和原神、绝区零编号，旧缓存只作退回", async () => {
  await runFixture(async ({ root, cache, clock, requests, downloads, search }) => {
    const disabled = search(false);
    for (const entry of entries) expect(await disabled(entry.command)).toEqual(reply(`old-${entry.id}`));
    expect(requests).toEqual([]);

    const enabled = search(true);
    const pending = enabled("#钟离一图流");
    expect(enabled("#岩王帝君一图流")).toBe(pending);
    expect(await pending).toEqual(reply("/1-1.png"));
    for (const entry of entries.slice(1)) expect(await enabled(entry.command)).toEqual(reply(`/${entry.id}-1.png`));
    expect(requests).toEqual(entries.map(entry => entry.id));
    expect(downloads).toHaveLength(entries.length);

    clock.now += minute;
    clock.revision = 2;
    const restarted = search(true);
    for (const entry of entries) {
      expect(await restarted(entry.command)).toEqual(reply(`/${entry.id}-1.png`));
      expect(await readFile(join(cache, entry.path))).toEqual(image(`/${entry.id}-1.png`));
      if ("legacy" in entry) expect(await readFile(join(root, entry.legacy))).toEqual(image(`old-${entry.id}`));
    }
    expect(downloads).toHaveLength(entries.length);
    expect(requests).toHaveLength(entries.length);
  });
});

test("校验失败保留旧图，短退避到期后复查，显式刷新即使关闭开关也走源", async () => {
  await runFixture(async ({ cache, clock, requests, makeStale, search }) => {
    clock.offline = true;
    const enabled = search(true);
    for (const entry of entries) expect(await enabled(entry.command)).toEqual(reply(`old-${entry.id}`));
    expect(requests).toHaveLength(entries.length);
    for (const entry of entries) expect(await enabled(entry.command)).toEqual(reply(`old-${entry.id}`));
    expect(requests).toHaveLength(entries.length);

    expect(await enabled("%更新艾莲攻略2")).toEqual(reply("old-2727116"));
    expect(requests.filter(id => id === "2727116")).toHaveLength(2);
    clock.offline = false;
    clock.now += 5 * minute;
    expect(await enabled("#钟离一图流")).toEqual(reply("/1-1.png"));
    expect(requests.filter(id => id === "1")).toHaveLength(2);
    expect(await readFile(join(cache, entries[0].path))).toEqual(image("/1-1.png"));

    await makeStale(entries[0].path);
    clock.now += day;
    clock.revision = 2;
    expect(await enabled("#钟离一图流")).toEqual(reply("/1-2.png"));
    expect(requests.filter(id => id === "1")).toHaveLength(3);

    clock.revision = 3;
    clock.offlineImage = true;
    expect(await enabled("#更新钟离一图流")).toEqual(reply("/1-2.png"));
    expect(await readFile(join(cache, entries[0].path))).toEqual(image("/1-2.png"));
    clock.offlineImage = false;
    const disabled = search(false);
    expect(await disabled("#钟离一图流")).toEqual(reply("/1-2.png"));
    expect(await disabled("#更新钟离一图流")).toEqual(reply("/1-3.png"));
    expect(await disabled("#更新心海攻略4")).toEqual(reply("/341523-3.png"));
    expect(await disabled("%更新艾莲攻略2")).toEqual(reply("/2727116-3.png"));
    expect(requests.filter(id => id === "1")).toHaveLength(5);
  });
});
