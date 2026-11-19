import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRegistry } from "../../lib/commands.ts";
import type { MessageEvent } from "../../lib/messages.ts";
import { createGuidesModule } from "./index.ts";

const roots: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
const title = "绫人配队详情";
const image = (name: string) => ({ type: "image" as const, file: Buffer.concat([png, Buffer.from(name)]) });
const ayato = [image("绫人超绽"), image("绫云班万"), image("水系")];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(forward = true) {
  const root = await mkdtemp(join(tmpdir(), "lotus-team-guides-test-"));
  roots.push(root);
  const directory = join(root, "TeamGuides");
  const tea = join(directory, "茗血茶");
  const kama = join(directory, "卡玛sei亚");
  await mkdir(tea, { recursive: true });
  await mkdir(kama);
  await writeFile(join(directory, "teamGuides.yaml"), `
茗血茶:
  神鹤心万: {alias: [神鹤万心], role: [神里绫华]}
  绫人超绽: {alias: [绫人, 绫久], role: [神里绫人, 草主]}
  万达国际: {alias: [万达], role: [达达利亚]}
  绫云班万: {alias: [], role: [神里绫人]}
卡玛sei亚:
  水系: [神里绫人]
  国家: [达达利亚]
`);
  for (const name of ["神鹤心万", "绫人超绽", "万达国际", "绫云班万"]) await writeFile(join(tea, name + ".png"), image(name).file);
  await writeFile(join(kama, "水系.png"), image("水系").file);
  const commands = new CommandRegistry();
  commands.registerModule(createGuidesModule({ directory, forward }));
  function request(msg: string, normalized = msg, enabled = true) {
    const event: MessageEvent = {
      msg, raw_message: msg, message: msg, message_type: "group", post_type: "message",
      isGroup: true, isPrivate: false, isMaster: false, reply: () => true,
    };
    return commands.dispatchFallback(event, () => enabled, () => false, normalized);
  }
  return { root, directory, tea, kama, request };
}

test("旧队名、别名和角色查询保留顺序并合并转发", async () => {
  const { request } = await setup();
  expect(await request("#神鹤万心配队")).toEqual(image("神鹤心万"));
  expect(await request("#万达队配队")).toEqual(image("万达国际"));
  expect(await request("#绫人配队")).toEqual({ type: "forward", nodes: [title, ...ayato] });
  expect(await request("#Ayato配队")).toEqual({ type: "forward", nodes: ["Ayato配队详情", ...ayato] });
  expect(await request("#10000066配队")).toEqual({ type: "forward", nodes: ["10000066配队详情", ...ayato] });
  expect(await request("#草主配队")).toEqual(image("绫人超绽"));
  expect(await request("#旅行者配队")).toBe("请选择旅行者配队：风主配队、岩主配队、雷主配队、草主配队、水主配队、火主配队、冰主配队");
});

test("直发设置、错误输入与部分资源缺失", async () => {
  const { root, directory, tea, kama, request } = await setup(false);
  expect(await request("#绫人配队")).toEqual([title, ...ayato]);
  expect(await request("#不存在配队")).toContain("暂无");
  expect(await request("#绫人配队", "#绫人配队", false)).toBeUndefined();
  expect(await request("*丹恒配队", "#星铁丹恒配队")).toBeUndefined();
  expect(await request("#绝区零艾莲配队")).toBeUndefined();
  expect(await request("#深渊配队")).toBeUndefined();

  const outside = join(root, "outside.png");
  await writeFile(outside, png);
  await rm(join(kama, "水系.png"));
  await symlink(outside, join(kama, "水系.png"));
  await rm(join(tea, "绫云班万.png"));
  expect(await request("#绫人配队")).toEqual(image("绫人超绽"));
  await rm(join(tea, "绫人超绽.png"));
  expect(await request("#绫人配队")).toContain("没找到");
  await rm(directory, { recursive: true });
  expect(await request("#绫人配队")).toContain("原神配队资源不可用");
});
