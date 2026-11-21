import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGenshinCalendar, genshinCalendarContentUrl, genshinCalendarListUrl } from "./calendar-data.ts";
import { createGenshinCalendar } from "./calendar.ts";
import { genshinCalendarExtras } from "./genshin-calendar-theme.ts";

const at = (value: string) => Date.parse(value + "+08:00");
const show = (ann_id: number, title: string) => ({
  ann_id, title, start_time: "2026-11-19 16:00:00", end_time: "2026-12-15 14:59:59",
  banner: "https://sdk-webstatic.mihoyo.com/banners/original.png",
});

test("原神区分公告分类，读取祈愿正文日期和绝对开服时间", () => {
  const character = "「华黍由仪」祈愿：「驹隙隐泉·兹白(岩)」概率UP！";
  const active = "「万序衍盈」祈愿：「列律名虚·米提亚(雷)」概率UP！";
  const content = {
    retcode: 0, data: { list: [
      { ann_id: 6, title: "「坏灭肇始之时」7.2版本更新说明", content: "〓更新时间〓 2026/11/04 06:00 开始，预计5个小时完成。" },
      { ann_id: 1, title: character, content: "〓祈愿介绍〓 祈愿时间 概率提升角色（5星） 2026/11/24 18:00 ~ 2026/12/15 14:59" },
      { ann_id: 2, title: active, content: "〓祈愿介绍〓 祈愿时间 概率提升角色（5星） 7.2版本更新后 ~ 2026/11/24 17:59" },
    ] },
  };
  const list = {
    retcode: 0, data: { timezone: 8, list: [
      { type_label: "千星奇域", list: [show(10, "创作赛")] },
      { type_label: "活动公告", list: [
        show(1, character), show(2, active), show(3, "「神铸赋形」祈愿：「单手剑·朏魄含光」概率UP！"),
        show(4, "「炎天铸名」祈愿：集录祈愿开启！"), show(5, "深境螺旋轮换"),
      ] },
      { type_label: "游戏公告", list: [show(7, "公告标题")] },
    ] },
  };
  const model = buildGenshinCalendar(list, content, at("2026-11-20T04:30:00"));
  expect(model.detailsAvailable).toBe(true);
  expect(model.rows.map(({ kind }) => kind)).toEqual(["character", "character", "chronicled", "weapon", "normal"]);
  expect(model.rows[0]).toMatchObject({ character: "米提亚", start: at("2026-11-04T11:00:00"), end: at("2026-11-24T17:59:00") });
  expect(model.rows[1]).toMatchObject({
    character: "兹白", start: at("2026-11-24T18:00:00"), end: at("2026-12-15T14:59:00"),
    banner: "https://sdk-webstatic.mihoyo.com/banners/original.png",
  });
  expect(model.rows[3]?.title).toContain("「朏魄含光」");
  expect(model.rows.at(-1)?.banner).toBeUndefined();
});

test("原神日历使用原国服公告，旧品牌入口停用", async () => {
  const requests: string[] = [];
  const transport = (async (url: string) => { requests.push(url); return new Response(null, { status: 503 }); }) as typeof fetch;
  const command = createGenshinCalendar({ fetch: transport });
  for (const name of ["喵喵日历", "喵喵日历列表", "#喵喵日历", "#喵喵日历列表"]) {
    expect(command(name)).toBeUndefined();
  }
  expect(requests).toEqual([]);
  expect(await command("#日历列表")).toContain("无法读取原神官方");
  expect(requests).toEqual([genshinCalendarListUrl, genshinCalendarContentUrl]);
  expect(command("#星铁日历")).toBeUndefined();
});

test("旧卡池时间命令只读正文确认且已生效的国服公告，保留原图和整天显示", async () => {
  const title = "「万序衍盈」祈愿：「列律名虚·米提亚(雷)」概率UP！";
  const future = "「华黍由仪」祈愿：「驹隙隐泉·兹白(岩)」概率UP！";
  const weapon = "「神铸赋形」祈愿：「法器·秘星典谕」概率UP！";
  const unverified = "「炎天铸名」祈愿：集录祈愿开启！";
  const until = "〓祈愿介绍〓 祈愿时间 7.2版本更新后 ~ &lt;t&gt;2026/11/24 17:59&lt;/t&gt;";
  const list = { retcode: 0, data: { timezone: 8, list: [{ type_label: "活动公告", list: [
    { ...show(1, title), banner: "https://sdk-webstatic.mihoyo.com/banners/character.png" },
    { ...show(2, future), banner: "https://sdk-webstatic.mihoyo.com/banners/future.png" },
    { ...show(3, weapon), banner: "https://sdk-webstatic.mihoyo.com/banners/weapon.png" },
    show(4, unverified),
  ] }] } };
  const content = { retcode: 0, data: { list: [
    { ann_id: 7, title: "7.2版本更新说明", content: "〓更新时间〓 2026/11/04 06:00 开始，预计5个小时完成。" },
    { ann_id: 1, title, content: until },
    { ann_id: 2, title: future, content: "〓祈愿介绍〓 祈愿时间 2026/11/24 18:00 ~ 2026/12/15 14:59:59" },
    { ann_id: 3, title: weapon, content: until },
    { ann_id: 4, title: unverified, content: "请在游戏内查看" },
  ] } };
  const png = Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
  const requests: string[] = [];
  let now = at("2026-11-22T18:00:00");
  let details = true;
  const transport = (async (url: string, options: RequestInit) => {
    requests.push(url);
    expect(options).toMatchObject({ credentials: "omit", redirect: "error" });
    if (url === genshinCalendarListUrl) return Response.json(list);
    if (url === genshinCalendarContentUrl) return details ? Response.json(content) : new Response(null, { status: 503 });
    if (url.endsWith("/weapon.png")) return new Response("暂时无法取得原图");
    return new Response(png);
  }) as typeof fetch;
  const command = createGenshinCalendar({ now: () => now, fetch: transport });
  for (const alias of ["#星铁卡池时间", "#原神卡池历史", "#芙宁娜卡池时间", "#6.7卡池", "%卡池剩余时间"]) {
    expect(command(alias)).toBeUndefined();
  }
  expect(requests).toEqual([]);
  const first = await command("#卡池剩余时间");
  if (!Array.isArray(first)) throw Error(String(first));
  const text = first.filter(part => typeof part === "string").join("");
  expect(text).toContain("米提亚");
  expect(text).toContain("秘星典谕");
  expect(text).not.toContain("兹白");
  expect(text).not.toContain("集录");
  expect(text.match(/卡池剩余时间：2天/gu)).toHaveLength(1);
  expect(first.filter(part => typeof part === "object")).toEqual([{ type: "image", file: Buffer.from(png) }]);
  expect(requests.some(url => url.endsWith("/future.png"))).toBe(false);

  now = at("2026-11-24T17:59:59");
  expect(JSON.stringify(await command("原神卡池剩下时间"))).toContain("卡池剩余时间：1天");
  now = at("2026-11-24T18:00:00");
  const next = JSON.stringify(await command("＃原神卡池时间"));
  expect(next).toContain("兹白");
  expect(next).not.toContain("米提亚");
  now = at("2026-12-15T14:59:59");
  expect(JSON.stringify(await command("##卡池时间"))).toContain("卡池剩余时间：1天");
  now = at("2026-12-15T15:00:00");
  expect(await command("#卡池时间")).toContain("暂无法从国服官方公告核验");
  now = at("2026-11-22T18:00:00");
  details = false;
  const listOnly = createGenshinCalendar({ now: () => now, fetch: transport });
  expect(await listOnly("#卡池时间")).toContain("暂无法从国服官方公告核验");
});

test("原神生日使用旧角色资料，天赋材料在北京时间四点更换", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-calendar-theme-test-"));
  const roles = join(root, "meta-gs/character");
  try {
    await mkdir(join(roles, "琴"), { recursive: true });
    await mkdir(join(roles, "莫娜"), { recursive: true });
    await writeFile(join(roles, "data.json"), JSON.stringify({
      10000003: { name: "琴", star: 5, eta: 1600070400000 },
      10000041: { name: "莫娜", star: 5, eta: 1600070400000 },
    }));
    await writeFile(join(roles, "琴/data.json"), JSON.stringify({ birth: "11-20", materials: { talent: "「抗争」的哲学", weekly: "东风之翎" } }));
    await writeFile(join(roles, "莫娜/data.json"), JSON.stringify({ birth: "11-22", materials: { talent: "「自由」的哲学" } }));
    const start = at("2026-11-14T00:00:00");
    const before = await genshinCalendarExtras(root, start, at("2026-11-20T03:59:00"));
    expect(before.birthdays[6]?.[0]?.name).toBe("琴");
    expect(before.materials.map(({ name }) => name)).toEqual(["自由"]);
    const after = await genshinCalendarExtras(root, start, at("2026-11-20T04:00:00"));
    expect(after.materials.map(({ name }) => name)).toEqual(["抗争"]);
    expect(after.materials[0]?.roles[0]?.weekly).toBe("东风之翎");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
