import { expect, test } from "bun:test";
import { calendarContentUrl, calendarListUrl, buildStarrailCalendar, calendarTime, createStarrailCalendarSource } from "./starrail-calendar-data.ts";
import { createStarrailCalendar } from "./starrail-calendar.ts";

const now = Date.parse("2026-11-20T03:30:00+08:00");
const raw = {
  retcode: 0, data: { timezone: 8, list: [{ list: [
    { ann_id: 17, title: "跃迁记录统计上线", start_time: "2026-11-09 13:00:00", end_time: "2036-12-23 04:00:00" },
    { ann_id: 22, title: "异相仲裁新一期", start_time: "2026-11-11 05:00:00", end_time: "2026-12-23 06:00:00" },
    { ann_id: 33, title: "有奖问卷", start_time: "2026-11-13 04:00:00", end_time: "2026-12-23 04:00:00" },
  ] }], pic_list: [{ type_list: [{ list: [
    { ann_id: 17, title: "「开场好礼先抱走」活动说明", start_time: "2026-10-30 20:20:00", end_time: "2026-12-23 05:59:00" },
    { ann_id: 25, title: "4.7版本活动跃迁（其一）", start_time: "2026-11-10 11:00:00", end_time: "2026-12-02 11:59:00" },
    { ann_id: 26, title: "「开拓任务」", start_time: "2026-11-10 04:00:00", end_time: "2026-12-23 04:00:00" },
  ] }] }] },
};
const detail = {
  retcode: 0, data: { list: [
    { ann_id: 77, title: "4.7版本「此刻，将群星付之一笑」版本更新说明", content: "■更新时间 <t>2026/11/11 06:00:00</t>开始，预计5个小时完成。 ■补偿说明" },
    { ann_id: 22, title: "异相仲裁新一期", content: "<h1>活动时间</h1>2026/11/19 04:00:00 - 2026/12/21 03:59:00" },
  ], pic_list: [
    { ann_id: 17, title: "「开场好礼先抱走」活动说明", content: "<h1>领取时间</h1>4.7版本更新后 - <t>2026/12/23 05:59:00</t>",
      img: "https://sdk-webstatic.mihoyo.com/notice/real.png" },
    { ann_id: 25, title: "4.7版本活动跃迁（其一）", content: "跃迁时间为4.7版本更新后 - &lt;t class=\"t_lc\"&gt;2026/12/22 15:00:00&lt;/t&gt;。跃迁时间为4.7版本更新后 - 2026/12/02 11:59:00。",
      img: "https://outside.invalid/spoof.png" },
    { ann_id: 26, title: "「开拓任务」", content: "<h1>开放时间</h1>4.7版本更新后永久开放" },
  ] },
};

test("原公告正文、同编号活动、版本更新后与旧十三天日期窗口", () => {
  const model = buildStarrailCalendar(raw, detail, now);
  expect(new Date(model.start).toISOString()).toBe("2026-11-13T16:00:00.000Z");
  expect(new Date(model.end).toISOString()).toBe("2026-11-26T16:00:00.000Z");
  expect(model.detailsAvailable).toBe(true);
  expect(model.rows.map(({ kind }) => kind)).toEqual(["abyss-4", "character", "activity", "activity", "activity"]);
  expect(model.rows.find(({ title }) => title.includes("开场好礼"))).toMatchObject({
    start: Date.parse("2026-11-11 11:00:00+08:00"), end: Date.parse("2026-12-23 05:59:00+08:00"),
    banner: "https://sdk-webstatic.mihoyo.com/notice/real.png",
  });
  expect(model.rows.find(({ title }) => title.startsWith("跃迁记录"))?.start).toBe(Date.parse("2026-11-09 13:00:00+08:00"));
  const warp = model.rows.find(({ kind }) => kind === "character");
  expect(warp?.start).toBe(Date.parse("2026-11-11 11:00:00+08:00"));
  expect(warp?.earliestEnd).toBe(Date.parse("2026-12-02 11:59:00+08:00"));
  expect(warp?.end).toBe(Date.parse("2026-12-22 15:00:00+08:00"));
  expect(warp?.banner).toBeUndefined();
  expect(model.rows.find(({ title }) => title === "「开拓任务」")?.permanent).toBe(true);
  expect(calendarTime("2026/11/31 04:00:00")).toBeUndefined();
  expect(() => buildStarrailCalendar({ ...raw, data: { ...raw.data, timezone: 7 } }, detail, now)).toThrow("时区变化");
});

test("正文缺失提示，短时复用并在列表故障时使用旧数据", async () => {
  let clock = now;
  let offline = false;
  let noDetails = false;
  const requests: string[] = [];
  const transport = (async (url: string, init: RequestInit) => {
    requests.push(url);
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    if (offline || (noDetails && url === calendarContentUrl)) return new Response(null, { status: 503 });
    return Response.json(url === calendarListUrl ? raw : detail);
  }) as typeof fetch;
  const source = createStarrailCalendarSource({ fetch: transport, now: () => clock });
  expect((await source()).detailsAvailable).toBe(true);
  expect((await source()).stale).toBe(false);
  expect(requests).toEqual([calendarListUrl, calendarContentUrl]);
  clock += 601_000;
  offline = true;
  expect((await source()).stale).toBe(true);
  clock += 6 * 3_600_000;
  await expect(source()).rejects.toThrow("无法访问");
  const command = createStarrailCalendar({ fetch: transport });
  expect(await command("#星铁日历列表")).toContain("暂时无法读取");
  expect(command("#星铁日历 帮助")).toBeUndefined();
  offline = false;
  noDetails = true;
  const plain = await source();
  expect(plain.detailsAvailable).toBe(false);
  expect(plain.rows.some(({ kind }) => kind === "abyss-4")).toBe(false);
  expect(plain.rows.length).toBeGreaterThan(0);
});
