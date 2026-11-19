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

test("原神旧命令使用原国服公告，独立于星铁入口和缓存", async () => {
  const requests: string[] = [];
  const transport = (async (url: string) => { requests.push(url); return new Response(null, { status: 503 }); }) as typeof fetch;
  const command = createGenshinCalendar({ fetch: transport });
  expect(await command("喵喵日历列表")).toContain("无法读取原神官方");
  expect(requests).toEqual([genshinCalendarListUrl, genshinCalendarContentUrl]);
  expect(command("#星铁日历")).toBeUndefined();
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
