import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRoleGuides } from "./role-guides.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
const image = (name: string) => Buffer.concat([png, Buffer.from(name)]);
const part = (name: string) => ({ type: "image" as const, file: image(name) });

test("星铁旧攻略编号、全部及主人配置沿用作者合集，和新版一图流分开", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-sr-numbered-guides-"));
  const cache = join(root, "cache");
  const archived = join(root, "backup/plugins/StarRail-plugin");
  const requests: number[] = [];
  const images: string[] = [];
  const driver = Object.assign(async (target: URL | string | Request, init?: RequestInit) => {
    const url = new URL(target instanceof Request ? target.url : target);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    if (url.hostname === "bbs-api.mihoyo.com") {
      expect(url.searchParams.get("gids")).toBe("6");
      const id = Number(url.searchParams.get("collection_id"));
      requests.push(id);
      const posts = id === 1996095 || id === 2029394 ? [{
        post: { subject: "希儿" },
        image_list: [
          { size: 9000, height: 120, url: "https://upload-bbs.miyoushe.com/short.jpg" },
          { size: 1000, height: 780, url: `https://upload-bbs.miyoushe.com/${id}.jpg` },
        ],
      }] : [];
      return Response.json({ retcode: 0, data: { posts } });
    }
    expect(url.hostname).toBe("upload-bbs.miyoushe.com");
    expect(url.searchParams.get("x-oss-process")).toContain("format,jpg");
    images.push(url.pathname);
    return new Response(Uint8Array.from(image(url.pathname)));
  }, { preconnect: fetch.preconnect });
  async function put(path: string, value: string | Buffer) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  }
  const config = join(archived, "config/mys.yaml");
  try {
    await put(config, 'defaultSource: "2"\n');
    await put(join(archived, "temp/strategy/2/希儿.jpg"), image("旧缓存二号"));
    await put(join(archived, "config/alias.yaml"), "希儿: [归档蝴蝶信使]\n");
    await put(join(cache, "add_ons", "新作者", "StarRail", "希儿.png"), image("当期一图流"));
    await put(join(cache, "mora/StarRail/希儿/index.json"), JSON.stringify({ checkedAt: Date.now(), files: [] }));
    await put(join(root, "config/guides.yaml"), "sr_collections: []\n");
    const search = createRoleGuides({ cache, settingsRoot: pathToFileURL(root + "/"), guideAutomatic: false, fetch: driver });
    expect(await search("＊攻略说明")).toContain("2. 小橙子阿");
    expect(await search("*攻略帮助")).toContain("3. 星穹中心");
    expect(await search("*希儿攻略")).toEqual(["旧编号 2 · 小橙子阿 · 希儿攻略", part("旧缓存二号")]);
    expect(await search("#星铁希儿一图流")).toEqual(part("当期一图流"));
    expect(await search("*归档蝴蝶信使攻略2")).toEqual(await search("*希儿攻略2"));
    expect(await search("*希儿攻略4")).toBeUndefined();
    expect(await search("*设置默认攻略0")).toContain("只有主人");
    let ownerChecks = 0;
    expect(await search("#设置默认攻略0", true, () => ++ownerChecks < 2)).toContain("保存星铁默认攻略失败");
    expect(await search("#设置默认攻略0", true)).toContain("全部旧编号来源");
    const all = await search("*希儿攻略");
    expect(all).toMatchObject({ type: "forward", nodes: [
      [expect.stringContaining("初始镜像"), part("/1996095.jpg")],
      [expect.stringContaining("小橙子阿"), part("旧缓存二号")],
      [expect.stringContaining("星穹中心"), part("/2029394.jpg")],
    ] });
    expect(await search("sr希儿攻略all")).toEqual(all);
    expect(await search("*希儿攻略0")).toEqual(all);
    expect(await readFile(config, "utf8")).toBe('defaultSource: "2"\n');
    expect(JSON.parse(await readFile(join(cache, "starrail-strategy.json"), "utf8"))).toEqual({ defaultSource: 0 });
    expect(requests.sort()).toEqual([1996095, 2009142, 2029394, 2038092]);
    expect(images.sort()).toEqual(["/1996095.jpg", "/2029394.jpg"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
