import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRoleGuides } from "./role-guides.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
const image = (name: string) => Buffer.concat([png, Buffer.from(name)]);
const reply = (name: string) => ({ type: "image" as const, file: image(name) });

test("绝区零编号使用原站与准确作者缓存，全部保留原顺序和缺图，旧设置安全迁入", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-zzz-guide-"));
  const cache = join(root, "cache");
  const legacy = join(root, "legacy");
  const legacyConfig = join(legacy, "config/guide.yaml");
  async function put(file: string, contents: string | Buffer) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  const calls: string[] = [];
  let failed = false;
  let revision = 1;
  const transport = (async (target: URL, init: RequestInit) => {
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    const url = new URL(target);
    if (url.hostname === "bbs-api.mihoyo.com") {
      calls.push(`${url.searchParams.get("gids")}/${url.searchParams.get("collection_id")}`);
      if (failed) return new Response(null, { status: 503 });
      const id = url.searchParams.get("collection_id");
      expect(url.searchParams.has("order_type")).toBe(id === "6");
      const fields = (file: string, size: number, format = "png") => ({
        url: "https://upload-bbs.miyoushe.com/" + file, size, format,
      });
      const posts = id === "2727116" ? [
        { post: { subject: "【艾莲版本】其他角色" }, image_list: [fields("version-block.png", 3000)] },
        { post: { subject: "【2.1版本】艾莲乔" }, image_list: [fields("gif.gif", 90000, "gif"),
          fields("small.png", 10), fields("source2-" + revision + ".png", 100)] },
      ] : [];
      return Response.json({ retcode: 0, data: { posts } });
    }
    expect(url.hostname).toBe("upload-bbs.miyoushe.com");
    expect(url.searchParams.get("x-oss-process")).toBe("image/resize,s_1200/quality,q_90/auto-orient,0/interlace,1/format,jpg");
    calls.push(url.pathname);
    return new Response(image(url.pathname));
  }) as typeof fetch;

  try {
    await put(join(legacy, "defSet/guide.yaml"), "default_guide: 1\nmax_forward_guides: 4\n");
    const configuration = 'default_guide: all\nmax_forward_guides: "3"\nother: untouched\n';
    await put(legacyConfig, configuration);
    await put(join(legacy, "config/alias.yaml"), "艾莲: [鲨鱼妹]\n");
    await put(join(legacy, "resources/images/guides/新艾利都快讯/role_guide_艾莲.png"), image("old-source1"));
    await put(join(cache, "新艾利都快讯/ZenlessZoneZero/妮可.jpg"), image("plain-mora"));
    await put(join(root, "config/zzzRoleGuides.yaml"), "- {source: 新艾利都快讯, collection_id: [6]}\n");
    for (const name of ["艾莲", "妮可"]) {
      await put(join(cache, "mora/ZenlessZoneZero", name, "index.json"), JSON.stringify({ checkedAt: Date.now(), files: [] }));
    }
    const build = () => createRoleGuides({ cache, config: join(root, "config"), legacyZzzRoot: legacy,
      legacyZzzResources: join(legacy, "resources"), guideAutomatic: false, fetch: transport });
    let search = build();
    expect(await search("％攻略帮助")).toContain("7. HoYo青枫");
    expect(await search("%鲨鱼妹攻略1")).toEqual(reply("old-source1"));
    expect(calls).toEqual([]);
    expect(await search("#绝区零唉不存在攻略8")).toContain("超出范围");
    expect(await search("%艾莲攻略2")).toEqual(reply("/source2-1.png"));
    expect(calls).toEqual(["8/2727116", "/source2-1.png"]);
    expect(await search("#绝区零艾莲一图流")).toBe("暂无艾莲的绝区零攻略。");
    expect(calls).toContain("2/6");
    const all = { type: "forward" as const, nodes: [reply("old-source1"), reply("/source2-1.png"), "暂无艾莲攻略（小橙子阿）。"] };
    expect(await search("%艾莲攻略all")).toEqual(all);
    expect(await search("%艾莲攻略0")).toEqual(all);
    expect(await search("#绝区零艾莲攻略")).toEqual(all);
    expect(await search("#绝区零妮可攻略")).toEqual(reply("plain-mora"));
    expect(await search("%设置所有攻略显示个数1")).toContain("只有主人");
    expect(await search("%设置所有攻略显示个数0", true)).toContain("须为 1–7");
    const saved = await Promise.all([search("%设置默认攻略2", true), search("%设置所有攻略显示个数1", true)]);
    expect(saved[0]).toContain("清茶沐沐Kiyotya");
    expect(saved[1]).toContain("为 1");
    expect(JSON.parse(await readFile(join(cache, "zzz-strategy.json"), "utf8"))).toEqual({ default_guide: 2, max_forward_guides: 1 });
    expect(await readFile(legacyConfig, "utf8")).toBe(configuration);
    search = build();
    expect(await search("#绝区零艾莲攻略")).toEqual(reply("/source2-1.png"));
    expect(await search("%艾莲攻略all")).toEqual({ type: "forward", nodes: [reply("old-source1")] });
    revision = 2;
    expect(await search("%刷新鲨鱼妹攻略2")).toEqual(reply("/source2-2.png"));
    failed = true;
    expect(await search("%更新艾莲攻略2")).toEqual(reply("/source2-2.png"));
    expect(await search("%更新艾莲攻略1")).toEqual(reply("old-source1"));
    expect(await search("%设置默认攻略all", true)).toContain("全部");
    expect(await search("#绝区零艾莲攻略")).toEqual({ type: "forward", nodes: [reply("old-source1")] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 8_000);
