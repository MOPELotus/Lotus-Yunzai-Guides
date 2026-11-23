import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRoleGuides } from "./role-guides.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
const image = (name: string) => Buffer.concat([png, Buffer.from(name)]);

test("星铁旧合集保留历史版本、原图顺序及各期配队，单图归档优先", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-sr-history-guides-"));
  const accessed: string[] = [];
  const raw = "https://raw.githubusercontent.com/TsukinaKasumi/StarRail-plugin/308a83d25766d6ba6ac178783649f6ea0413a34e/resources/srsr/";
  const transport = Object.assign(async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.href.startsWith(raw)).toBe(true);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    const file = decodeURIComponent(url.href.slice(raw.length));
    accessed.push(file);
    if (file === "qd/辅助榜.jpg") return new Response(null, { status: 404 });
    return new Response(Uint8Array.from(image(file)));
  }, { preconnect: fetch.preconnect });
  try {
    const legacy = join(root, "backup/plugins/StarRail-plugin/resources/srsr/gz/商店光锥推荐.jpg");
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, image("旧光锥资料"));
    const search = createRoleGuides({ cache: join(root, "cache"), settingsRoot: pathToFileURL(root + "/"), fetch: transport });
    expect(await search("*商店光锥推荐")).toEqual(["星铁商店光锥推荐（历史资料）", "商店光锥推荐", {
      type: "image", file: image("旧光锥资料"),
    }]);
    expect(accessed).toHaveLength(0);
    expect(await search("＊收益曲线")).toMatchObject({ type: "forward", senderName: expect.stringContaining("历史资料"), nodes: [
      expect.stringContaining("收益曲线"), ...["基础属性收益曲线", "生存属性收益曲线", "最优攻击百分比", "减防收益曲线", "减抗收益曲线"]
        .map(label => [label, { type: "image", file: image(`sy/${label}.jpg`) }]),
    ] });
    expect(await search("#星铁全角色强度榜")).toMatchObject({ type: "forward", nodes: [
      expect.stringContaining("1.0"), ...Array.from({ length: 6 }, () => expect.any(Array)), expect.stringContaining("辅助榜.jpg"),
    ] });
    expect(await search("*攻略")).toMatchObject({ type: "forward", nodes: [
      expect.stringContaining("1.1 下半"), ...Array.from({ length: 7 }, () => expect.any(Array)),
    ] });
    const hall = await search("*深渊攻略");
    expect(hall).toMatchObject({ type: "forward", batchSize: 6, nodes: [
      expect.stringContaining("忘却之庭 1.0"), ["忘却之庭", { type: "image", file: image("wq/忘却之庭.jpg") }],
      ["其一", { type: "image", file: image("wq/1.jpg") }],
      [expect.stringContaining("其一上半\n输出 丹恒、希儿、青雀"), { type: "image", file: image("wq/2.jpg") }],
      ...Array.from({ length: 28 }, () => expect.any(Array)),
    ] });
    expect(await search("sr忘却之庭攻略")).toEqual(hall);
    expect(accessed.filter(file => file.startsWith("wq/"))).toHaveLength(31);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
