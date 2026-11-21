import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRoleGuides } from "./role-guides.ts";
import { parseGuideCommand } from "./role-guide-input.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
const image = (name: string) => Buffer.concat([png, Buffer.from(name)]);
const reply = (name: string) => ({ type: "image" as const, file: image(name) });

test("原神编号攻略读取原作者和旧缓存，默认入口保留普通攻略优先级", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-numbered-guides-"));
  const cache = join(root, "cache");
  const legacy = join(root, "old");
  const settings = join(root, "legacy-mys.set.yaml");
  async function put(file: string, contents: string | Buffer) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  const requests: number[] = [];
  const downloaded: string[] = [];
  let unavailable = false;
  const driver = (async (target: URL, init: RequestInit) => {
    expect(init.credentials).toBe("omit");
    const url = new URL(target);
    if (url.hostname === "bbs-api.mihoyo.com") {
      const id = Number(url.searchParams.get("collection_id"));
      requests.push(id);
      expect(url.searchParams.get("gids")).toBe("2");
      expect(url.searchParams.get("order_type")).toBe("2");
      if (unavailable) return new Response(null, { status: 503 });
      const posts = id === 341523 ? [{
        post: { subject: "图文攻略", structured_content: '[{"insert":"珊瑚宫心海】"},{"insert":{"image":"some-id"}}]' },
        image_list: [{ image_id: "some-id", url: "https://upload-bbs.miyoushe.com/kokomi-4.png" }],
      }] : id === 1582613 ? [{
        post: { subject: "【早柚】" },
        image_list: [{ size: 200, url: "https://upload-bbs.miyoushe.com/sayu-5.png" }],
      }] : [];
      return Response.json({ retcode: 0, data: { posts } });
    }
    expect(url.hostname).toBe("upload-bbs.miyoushe.com");
    expect(url.searchParams.get("x-oss-process")).toContain("format,jpg");
    downloaded.push(url.pathname);
    return new Response(image(url.pathname));
  }) as typeof fetch;

  try {
    await put(settings, "foo: keep\ndefaultSource: 5\n");
    await put(join(root, "config/roleGuides.yaml"), "news: []\nolds: []\n");
    for (const name of ["珊瑚宫心海", "早柚", "钟离"]) {
      await put(join(cache, "mora/Genshin", name, "index.json"), JSON.stringify({ checkedAt: Date.now(), files: [] }));
    }
    await put(join(legacy, "4/珊瑚宫心海.jpg"), image("old-4"));
    await put(join(cache, "add_ons/用户自定义/钟离.jpg"), image("plain"));
    const build = () => createRoleGuides({ cache, config: join(root, "config"), legacyStrategies: [legacy],
      legacyStrategySettings: settings, guideAutomatic: false, fetch: driver });
    let search = build();
    expect(await search("#攻略说明")).toContain("7. 婧枫赛赛");
    expect(await search("#原神心海攻略4")).toEqual(reply("old-4"));
    expect(requests).toEqual([]);
    expect(await search("#更新心海攻略4")).toEqual(reply("/kokomi-4.png"));
    expect(requests).toEqual([341523]);
    expect(await search("#心海攻略4")).toEqual(reply("/kokomi-4.png"));
    expect(await readFile(join(legacy, "4/珊瑚宫心海.jpg"))).toEqual(image("old-4"));
    expect(await search("#早柚攻略")).toEqual(reply("/sayu-5.png"));
    expect(await search("#设置默认攻略4")).toContain("只有主人");
    expect(await search("#设置默认攻略4", true)).toContain("OH是姜姜呀");
    expect(await readFile(settings, "utf8")).toBe("foo: keep\ndefaultSource: 5\n");
    search = build();
    expect(await search("#心海攻略")).toEqual(reply("/kokomi-4.png"));
    expect(await search("#钟离攻略")).toEqual(reply("plain"));
    expect(await search("#钟离一图流")).toEqual(reply("plain"));
    expect(await search("#旅行者攻略4")).toContain("风主攻略4");
    expect(await search("#早柚攻略7")).toContain("婧枫赛赛");
    expect(requests).toContain(1812949);
    expect(downloaded).toEqual(["/kokomi-4.png", "/sayu-5.png"]);
    unavailable = true;
    const refresh = search("#更新心海攻略4");
    expect(search("#更新珊瑚宫心海攻略4")).toBe(refresh);
    expect(await refresh).toEqual(reply("/kokomi-4.png"));
    expect(parseGuideCommand("#星铁流萤攻略4")).toBeUndefined();
    expect(parseGuideCommand("#绝区零艾莲攻略4")).toBeUndefined();
    expect(parseGuideCommand("#心海一图流4")).toBeUndefined();
    expect(parseGuideCommand("#心海攻略8")).toBeUndefined();

    await put(join(legacy, "1/珊瑚宫心海.jpg"), image("source-1-other-collection"));
    await put(join(legacy, "2/珊瑚宫心海.jpg"), image("source-2-other-author"));
    await put(join(root, "config/roleGuides.yaml"), `news: []
olds:
- {source: 西风驿站, collection_id: [839176]}
- {source: 其他作者, collection_id: [813033]}
`);
    unavailable = false;
    requests.length = 0;
    search = build();
    expect(await search("#心海一图流")).toBe("暂无珊瑚宫心海的原神攻略。");
    expect(requests.toSorted((left, right) => left - right)).toEqual([813033, 839176]);
    expect(await search("#心海攻略1")).toEqual(reply("source-1-other-collection"));
    expect(await search("#心海攻略")).toEqual(reply("/kokomi-4.png"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
