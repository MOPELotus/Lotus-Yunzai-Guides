import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRoleMaterials } from "./role-materials.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
const artwork = (id: string) => Buffer.concat([png, Buffer.from(id)]);
const part = (id: string) => ({ type: "image" as const, file: artwork(id) });
const picture = (image: string) => `https://upload-bbs.miyoushe.com/${image}.jpg`;
const oss = "image//resize,s_1000/quality,q_80/auto-orient,0/interlace,1/format,jpg";
const listing = (subject: string, names: readonly string[], field: "image_list" | "post.images") => ({
  post: { subject, ...(field === "post.images" && { images: names.map(picture) }) },
  ...(field === "image_list" && { image_list: names.map(name => ({ url: picture(name) })) }),
});

async function withCache(run: (cache: string, legacy: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-role-materials-"));
  try { await run(join(root, "cache"), join(root, "legacy")); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("old Genshin and Star Rail collections use the same priority and field positions", () => withCache(async (cache, legacy) => {
  let revision = 1;
  const used: string[] = [];
  const fixture = {
    "428421": () => [listing("刻晴养成素材", ["other", `gs-keqing-${revision}`, "wrong"], "image_list"),
      listing("雷电将军养成素材", ["other", "omit", "gs-raiden"], "image_list")],
    "1164644": () => [listing("赛诺培养素材", ["gs-cyno"], "image_list")],
    "1362644": () => [listing("胡桃养成素材", ["omit", "omit", "gs-hutao"], "image_list")],
    "1998643": () => [listing("符玄晋阶材料", ["other", "omit", "sr-fuxuan"], "post.images")],
    "2146693": () => [listing("希儿晋阶材料", ["sr-seele", "omit"], "post.images")],
    "2279356": () => [listing("银狼晋阶材料", ["sr-silverwolf", "omit"], "image_list")],
  } as const;
  const materials = createRoleMaterials({ cache, legacy, async fetch(input, request) {
    const url = new URL(String(input));
    expect(request).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    if (url.hostname === "bbs-api.mihoyo.com") {
      const id = url.searchParams.get("collection_id") as keyof typeof fixture;
      expect(url.pathname).toBe("/post/wapi/getPostFullInCollection");
      expect(Object.fromEntries(url.searchParams)).toEqual({ gids: "2", order_type: "2", collection_id: id });
      used.push(id);
      return Response.json({ retcode: 0, data: { posts: fixture[id]() } });
    }
    expect(url.hostname).toBe("upload-bbs.miyoushe.com");
    expect(url.searchParams.get("x-oss-process")).toBe(oss);
    const name = url.pathname.slice(1, -4);
    used.push(name);
    return new Response(artwork(name));
  } });

  expect(await materials("#刻晴素材")).toEqual(part("gs-keqing-1"));
  expect(await materials("刻晴突破")).toEqual(part("gs-keqing-1"));
  expect(used).toEqual(["428421", "gs-keqing-1"]);
  expect(await materials("#雷神材料")).toEqual(part("gs-raiden"));
  expect(await materials("#赛诺培养")).toEqual(part("gs-cyno"));
  expect(await materials("#胡桃素材")).toEqual(part("gs-hutao"));
  expect(await materials("#星铁符玄素材")).toEqual(part("sr-fuxuan"));
  expect(await materials("#星铁希儿材料")).toEqual(part("sr-seele"));
  expect(await materials("#星铁银狼素材")).toEqual(part("sr-silverwolf"));
  expect(used).toEqual(["428421", "gs-keqing-1", "gs-raiden", "1164644", "gs-cyno", "1362644", "gs-hutao", "1998643",
    "sr-fuxuan", "2146693", "sr-seele", "2279356", "sr-silverwolf"]);
  revision = 2;
  expect(await materials("#更新刻晴素材")).toEqual(part("gs-keqing-2"));
  expect(used.slice(-2)).toEqual(["428421", "gs-keqing-2"]);
  expect(await readFile(join(cache, "gs", "友人A", "刻晴.jpg"))).toEqual(artwork("gs-keqing-2"));
  expect(await readFile(join(cache, "sr", "other", "希儿.jpg"))).toEqual(artwork("sr-seele"));
  expect(await materials("#刻晴素材", 10)).toContain("单图大小上限");
  for (const text of ["#今日材料", "#我的材料", "#绝区零艾莲素材", "#未知名字突破", "#刻晴材料图鉴", "#更新 刻晴素材"]) {
    expect(materials(text)).toBeUndefined();
  }
}));

test("legacy retained images are read offline and failed refresh leaves them intact", () => withCache(async (cache, legacy) => {
  const old = join(legacy, "gs", "友人A", "刻晴.jpg");
  await mkdir(dirname(old), { recursive: true });
  await writeFile(old, artwork("legacy"));
  let requests = 0;
  const material = createRoleMaterials({ cache, legacy, async fetch() { requests++; return Response.json({ retcode: 1 }); } });
  expect(await material("#刻晴素材")).toEqual(part("legacy"));
  expect(requests).toBe(0);
  expect(await material("#更新刻晴素材")).toEqual(part("legacy"));
  expect(requests).toBe(3);
  expect(await readFile(old)).toEqual(artwork("legacy"));
  expect(await Bun.file(join(cache, "gs", "友人A", "刻晴.jpg")).exists()).toBe(false);
}));
