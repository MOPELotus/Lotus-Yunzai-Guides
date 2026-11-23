import { expect, test } from "bun:test";
import { createAkashaAbyss, matchAkashaAbyss } from "./akasha-abyss.ts";
import type { AkashaCard } from "./akasha-card.ts";

const older = Date.UTC(2026, 10, 23);
const roster = { "1": { name: "天水" }, "2": { name: "月影" } };
const teams = Array.from({ length: 16 }, (_, index) => ({
  tl: index % 2 ? [2] : [1, 2], ac: 30 - index, mr: "15.01", uc: "19", umr: String(index + 40),
  dc: "11", dmr: "70.25", ud: "63:37",
}));
const source = { modify_time: "2024-06-03 07:12", schedule_version_desc: "4.6第二期",
  character_used_list: [{ name: "天水", value: 84.1, rarity: 5 }, { name: "月影", value: 12.3, rarity: 4 }],
  team_list: teams, team_up_list: teams, team_down_list: teams };

function response(variable: string, data: unknown) {
  return new Response(`var ${variable} = ${JSON.stringify(data)};`);
}

test("旧虚空星级、半场、指标、页码和帮助入口保持独立", () => {
  expect(matchAkashaAbyss("虚空使用率")).toEqual({ type: "usage", rarity: undefined });
  expect(matchAkashaAbyss("#虚空四星使用率")).toEqual({ type: "usage", rarity: 4 });
  expect(matchAkashaAbyss("#虚空深渊五星使用率")).toEqual({ type: "usage", rarity: 5 });
  expect(matchAkashaAbyss("#虚空队伍")).toEqual({ type: "teams", half: "全部", sort: "出战数", page: 1 });
  expect(matchAkashaAbyss("#虚空深渊下半队伍满星率7")).toEqual({ type: "teams", half: "下半", sort: "满星率", page: 7 });
  expect(matchAkashaAbyss("#虚空深渊队伍8")).toBeUndefined();
  expect(matchAkashaAbyss("#虚空深渊帮助")).toEqual({ type: "help" });
  expect(matchAkashaAbyss("#深渊上半队伍")).toBeUndefined();
});

test("用固定公共数据复核角色筛选、队伍页、字段半场归属与历史标注", async () => {
  const calls: string[] = [];
  const cards: AkashaCard[] = [];
  const handler = createAkashaAbyss({ signal: new AbortController().signal, clock: () => older,
    transport: async url => {
      calls.push(String(url));
      return String(url).endsWith("/abyss_total.js")
        ? response("static_abyss_total", source) : response("static_card_dict", roster);
    },
    draw: async card => { cards.push(card); throw new Error("用于文本回退"); },
  });
  expect(handler("#深渊")).toBeUndefined();
  expect(await handler("#虚空五星使用率")).toContain("历史快照");
  expect(cards[0]).toMatchObject({ type: "usage", characters: [{ name: "天水", rate: 84.1, rarity: 5 }] });
  expect(await handler("#虚空深渊上半队伍满星率")).toContain("月影 · 19 次 · 55.00% · 63:37");
  expect(cards[1]).toMatchObject({ type: "teams", page: 1, pageCount: 2, teams: [expect.objectContaining({ full: 55 }),
    ...Array.from({ length: 13 }, () => expect.any(Object))] });
  expect(await handler("#虚空深渊下半队伍2")).toContain("70.25%");
  expect(cards[2]).toMatchObject({ teams: [expect.objectContaining({ count: 11 }), expect.any(Object)] });
  expect(await handler("#虚空深渊下半队伍3")).toContain("第 3 页暂无队伍");
  expect(calls).toEqual(["https://akashadata.com/static/data/abyss_total.js", "https://akashadata.com/xstatic/json/static_card_dict.js"]);
});

test("只解析 JSON 赋值并共用刷新，坏快照保留上版，撤销后无请求", async () => {
  const controller = new AbortController();
  let now = older;
  let calls = 0;
  let corrupt = false;
  const handler = createAkashaAbyss({ signal: controller.signal, clock: () => now,
    transport: async url => {
      calls++;
      if (corrupt) return new Response("var static_abyss_total = {}; execute()");
      return String(url).endsWith("/abyss_total.js")
        ? response("static_abyss_total", source) : response("static_card_dict", roster);
    },
    draw: async () => { throw new Error("用于文本回退"); },
  });
  const first = await Promise.all([handler("#虚空四星使用率"), handler("#虚空队伍")]);
  expect(first[0]).toContain("12.3%");
  expect(first[1]).toContain("15.01%");
  expect(calls).toBe(2);
  corrupt = true;
  now += 600_001;
  expect(await handler("#虚空四星使用率")).toContain("历史快照");
  expect(calls).toBe(4);
  controller.abort();
  expect(await handler("#虚空深渊帮助")).toBeUndefined();
  expect(calls).toBe(4);
});
