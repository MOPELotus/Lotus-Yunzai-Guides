import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandReply } from "../../lib/commands.ts";
import { parseGuideCommand, resolveGuideRole } from "./role-guide-input.ts";
import { createRoleGuides } from "./role-guides.ts";
import { createRoleReferences } from "./role-references.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
const image = (name: string) => Buffer.concat([png, Buffer.from(name)]);
const part = (name: string) => ({ type: "image" as const, file: image(name) });
const forwarded = (title: string, ...images: string[]): CommandReply => ({ type: "forward", nodes: [title, ...images.map(part)] });

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
}

test("三游戏保留旧攻略命令、配置源、本地覆盖及旧 Atlas，更新失败退回已有原图", async () => {
  expect(resolveGuideRole("喵喵", "gs")).toMatchObject({ name: "迪奥娜", id: "10000039" });
  const root = await mkdtemp(join(tmpdir(), "lotus-role-guides-test-"));
  async function put(path: string, bytes: string | Uint8Array) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  try {
    const gitRoot = join(root, "upstream");
    const cache = join(root, "roleGuides");
    await put("upstream/Genshin/Roles/Guides/Asgater/钟离.png", image("钟离包"));
    await put("upstream/StarRail/Roles/Guides/Asgater/丹恒•腾荒.png", image("腾荒包"));
    await put("upstream/StarRail/Roles/Guides/Asgater/丹恒.png", image("丹恒包"));
    await put("upstream/ZenlessZoneZero/Roles/Guides/Asgater/艾莲.png", image("艾莲包"));
    await put("upstream/Genshin/Roles/RefStat/钟离.png", image("钟离参考面板"));
    await put("upstream/Genshin/Roles/YieldCurve/钟离.png", image("钟离收益曲线"));
    await put("upstream/Genshin/Roles/YieldCurve/帮助.png", image("收益曲线帮助"));
    await put("upstream/Genshin/Roles/RefStat/RefNotes.yaml", "url: https://www.miyoushe.com/ys/article/123\n钟离: {mainProp: 生命沙, viceProp: 生命, brief: 配装参考}\n");
    await put("upstream/StarRail/Roles/RefStat/罗刹.png", image("罗刹参考面板"));
    await put("upstream/StarRail/Roles/RefStat/帮助.png", image("星铁参考面板帮助"));
    await put("upstream/StarRail/Roles/RefStat/RefNotes.yaml", "url: https://www.miyoushe.com/sr/article/456\n");
    await put("atlas/star-rail-atlas/guide for role/1310.png", image("流萤旧 Atlas"));
    await put("atlas/zzz-atlas/角色攻略/艾莲.png", image("艾莲旧 Atlas"));
    await put("roleGuides/add_ons/Asgater/钟离.jpg", image("钟离本地覆盖"));
    await put("oldStrategy/1/钟离.jpg", image("钟离旧缓存"));
    await put("config/roleGuides.yaml", `news:
- {source: 作者, collection_id: ["1"]}
- {source: OH是姜姜呀, collection_id: [341523]}
olds: [{source: 西风驿站, collection_id: [4]}]
`);
    await put("config/srRoleGuides.yaml", `- {source: 听语惊花, collection_id: [5]}
- {source: 星穹中心, collection_id: [2]}
`);
    await put("config/zzzRoleGuides.yaml", `- {source: 新艾利都快讯, collection_id: [6]}
- {source: 收藏, collection_id: [3]}
`);
    git(gitRoot, "init", "--quiet", "--initial-branch=master", "--template=");
    git(gitRoot, "config", "user.name", "Fixture");
    git(gitRoot, "config", "user.email", "fixture@example.invalid");
    git(gitRoot, "config", "uploadpack.allowFilter", "true");
    git(gitRoot, "config", "uploadpack.allowAnySHA1InWant", "true");
    git(gitRoot, "add", "--all");
    git(gitRoot, "commit", "--quiet", "-m", "攻略来源");

    let failed = false;
    const requested: string[] = [];
    const transport = (async (target: URL, init: RequestInit) => {
      expect(init.credentials).toBe("omit");
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).has("cookie")).toBe(false);
      const url = new URL(target);
      const ids = url.searchParams;
      if (failed) return new Response(null, { status: 503 });
      if (url.hostname === "bbs-api.mihoyo.com") {
        const id = ids.get("collection_id") ?? "";
        expect(ids.get("gids")).toBe("2");
        requested.push(id);
        const names: Record<string, string> = { "1": "钟离", "2": "流萤", "3": "艾莲" };
        const name = names[id];
        const posts = id === "341523" ? [{
          post: { subject: "常驻攻略", structured_content: '[{"insert":"钟离】"},{"insert":{"image":"struct-id"}}]' },
          image_list: [
            { image_id: "other-id", size: 900, url: "https://example.invalid/ignored.png" },
            { image_id: "struct-id", size: 200, url: "https://upload-bbs.miyoushe.com/341523.png" },
          ],
        }] : name ? [{
          post: { subject: `【一图流】${name}` },
          image_list: [
            { size: 10, url: "https://example.invalid/ignored.png" },
            { size: 100, url: `https://upload-bbs.miyoushe.com/${id}.png` },
          ],
        }] : [];
        return Response.json({ retcode: 0, data: { posts } });
      }
      expect(url.hostname).toBe("upload-bbs.miyoushe.com");
      return new Response(image(url.pathname.slice(1)));
    }) as typeof fetch;
    const search = createRoleGuides({
      cache, legacyStrategies: [join(root, "oldStrategy")], atlas: join(root, "atlas"), config: join(root, "config"),
      guideSource: pathToFileURL(gitRoot).href, fetch: transport,
    });
    const reference = createRoleReferences({ cache, guideSource: pathToFileURL(gitRoot).href });
    expect(await search("岩王帝君攻略")).toEqual(forwarded("钟离攻略~", "钟离本地覆盖", "1.png", "341523.png", "钟离旧缓存"));
    expect(await search("#星铁萨姆一图流")).toEqual(forwarded("流萤攻略~", "流萤旧 Atlas", "2.png"));
    expect(requested).not.toContain("5");
    expect(await search("#绝区零艾莲攻略")).toEqual(forwarded("艾莲攻略~", "艾莲包", "艾莲旧 Atlas", "3.png"));
    expect(await search("#星铁丹恒攻略")).toEqual(part("丹恒包"));
    expect(await search("#星铁腾荒攻略")).toEqual(part("腾荒包"));
    expect(await search("#不存在角色攻略")).toBeUndefined();
    expect(await search("#星铁开拓者攻略")).toContain("请选择");
    expect(await search("#旅行者攻略")).toContain("草主攻略");
    expect(await search("#钟离进阶攻略")).toBeUndefined();
    expect(await reference("#钟离进阶攻略")).toEqual({
      type: "forward",
      nodes: [
        "钟离进阶参考 @blue菌hehe", [part("钟离参考面板"), "https://www.miyoushe.com/ys/article/123"],
        "圣遗物思路推荐：\n主词条：生命沙\n副词条：生命", part("钟离收益曲线"), "【蓝佬小课堂】：\n配装参考",
      ],
    });
    expect(await reference("#星铁罗刹参考面板")).toEqual([part("罗刹参考面板"), "https://www.miyoushe.com/sr/article/456"]);
    expect(await reference("#收益曲线帮助")).toEqual(expect.arrayContaining([part("收益曲线帮助")]));
    expect(await reference("#星铁参考面板帮助")).toEqual(expect.arrayContaining([part("星铁参考面板帮助")]));
    expect(requested).not.toContain("4");
    expect(requested).not.toContain("6");
    expect(await readFile(join(cache, "作者/钟离.jpg"))).toEqual(image("1.png"));
    failed = true;
    expect(await search("#更新钟离攻略")).toEqual(forwarded("钟离攻略~", "钟离本地覆盖", "1.png", "341523.png", "钟离旧缓存"));
    expect(parseGuideCommand("#原神更新钟离一图流")).toEqual({ game: "gs", role: "钟离", update: true });
    expect(parseGuideCommand("#星铁更新流萤攻略")).toEqual({ game: "sr", role: "流萤", update: true });
    expect(parseGuideCommand("#绝区零更新艾莲攻略")).toEqual({ game: "zzz", role: "艾莲", update: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
