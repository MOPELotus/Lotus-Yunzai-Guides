import { expect, test } from "bun:test";
import { buildZzzCalendar, zzzCalendarContentUrl, zzzCalendarListUrl } from "./calendar-data.ts";
import { createZzzCalendar } from "./calendar.ts";

const at = (value: string) => Date.parse(value + "+08:00");
const wrap = (title: string) => `<p style="white-space: pre-wrap;">${title}</p>`;
const entry = (ann_id: number, title: string) => ({
  ann_id, title: wrap(title), start_time: "2026-11-09 14:00:00", end_time: "2026-12-01 14:59:00",
  img: "https://sdk-webstatic.mihoyo.com/upload/ann/original.png",
});

test("绝区零读取图片公告的限时频段，保留相同编号的活动与旧公告筛选", () => {
  const signal = "3.3版本限时频段（下期）";
  const pass = "3.3版本「丽都城募」说明";
  const event = "「天使应援大作战」活动说明";
  const current = {
    retcode: 0, data: { timezone: 8,
      list: [{ list: [entry(239, "公平运营声明"), entry(1331, pass), entry(400, "剧变节点")] }, { list: [] }],
      pic_list: [{ type_list: [{ list: [
        entry(260, signal), entry(239, event), entry(265, "3.4版本前瞻特别节目预告"),
      ] }] }],
    },
  };
  const details = {
    retcode: 0, data: {
      list: [
        { ann_id: 1339, title: "3.3版本「重返天空的旅程」更新公告", subtitle: "3.3版本更新说明",
          content: "【更新开始时间】 2026/10/21 06:00（UTC+8） 预计5个小时完成。 【补偿说明】" },
        { ann_id: 1331, title: wrap(pass), content: "【活动时间】 3.3版本更新后 ~ 2026/11/30 03:59（服务器时间）" },
      ],
      pic_list: [
        { ann_id: 260, title: wrap(signal),
          content: "本期代理人与音擎调频活动时间为： 2026/11/11 12:00（服务器时间） ~ 2026/12/01 14:59（服务器时间）" },
        { ann_id: 239, title: wrap(event), content: "【活动时间】 3.2版本更新后 ~ 2026/11/30 03:59（服务器时间）" },
      ],
    },
  };
  const model = buildZzzCalendar(current, details, at("2026-11-20T04:42:00"));
  expect(model.detailsAvailable).toBe(true);
  const activities = model.rows.filter(({ kind }) => !kind.startsWith("abyss"));
  expect(activities.map(({ kind }) => kind)).toEqual(["tuning", "pass", "activity"]);
  expect(activities[0]).toMatchObject({
    title: signal, start: at("2026-11-11T12:00:00"), end: at("2026-12-01T14:59:00"),
    banner: "https://sdk-webstatic.mihoyo.com/upload/ann/original.png",
  });
  expect(activities[1]).toMatchObject({ title: "3.3版本「丽都城募」", start: at("2026-10-21T11:00:00"), end: at("2026-11-30T03:59:00") });
  expect(activities[2]?.title).toBe("「天使应援大作战」活动");
  expect(activities[2]).toMatchObject({ end: at("2026-11-30T03:59:00"), startUnverified: true });
});

test("绝区零沿用生产日历的版本公告、常驻公告及两类挑战时间轴", () => {
  const version = "3.3版本「重返天空的旅程」更新公告";
  const fraud = "《绝区零》谨防诈骗提醒";
  const faq = "《绝区零》PC端视觉体验升级功能使用FAQ（7月29日更新）";
  const survey = "游戏调研有奖问卷";
  const challenge = "「危局强袭」";
  const current = { retcode: 0, data: { list: [
    { list: [
      { ...entry(1339, version), subtitle: "3.3版本更新说明", start_time: "2026-10-21 06:00:00" },
      { ...entry(911, fraud), start_time: "2026-02-26 00:00:00", end_time: "2099-01-01 00:00:00" },
      { ...entry(912, faq), start_time: "2026-07-29 08:00:00", end_time: "2099-01-01 00:00:00" },
      entry(532, "标题变化的旧运营公告"),
    ] }, { list: [entry(913, survey), entry(914, challenge)] },
  ], pic_list: [] } };
  const now = at("2026-11-22T16:42:00");
  const fallback = buildZzzCalendar(current, undefined, now);
  expect(fallback.rows.map(({ title }) => title)).toEqual([challenge, "「剧变节点」", fraud, faq, version, survey]);
  expect(fallback.rows.slice(0, 2)).toEqual([
    { title: challenge, kind: "abyss-2", start: at("2026-11-13T04:00:00"), end: at("2026-11-27T04:00:00") },
    { title: "「剧变节点」", kind: "abyss-1", start: at("2026-11-27T04:00:00"), end: at("2026-12-11T04:00:00") },
  ]);
  expect(fallback.rows.filter(({ permanent }) => permanent).map(({ title }) => title)).toEqual([fraud, faq]);

  const updated = buildZzzCalendar(current, { retcode: 0, data: { list: [{
    ann_id: 914, title: challenge, content: "【挑战时间】2026/11/13 05:00 ~ 2026/11/27 05:00",
  }], pic_list: [] } }, now);
  const real = updated.rows.filter(({ kind }) => kind === "abyss-2");
  expect(real).toHaveLength(1);
  expect(real[0]).toMatchObject({ start: at("2026-11-13T05:00:00"), end: at("2026-11-27T05:00:00") });
});

test("绝区零日历命令走原国服公告接口，失败给出对应提示", async () => {
  const urls: string[] = [];
  const finished = Promise.withResolvers<void>();
  const transport = (async (url: string, init: RequestInit) => {
    urls.push(url);
    if (urls.length === 6) finished.resolve();
    expect(init.credentials).toBe("omit");
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  const calendar = createZzzCalendar({ fetch: transport });
  expect(await calendar("#绝区零日历列表")).toContain("无法读取绝区零官方");
  await finished.promise;
  expect(urls.filter(url => url === zzzCalendarListUrl)).toHaveLength(3);
  expect(urls.filter(url => url === zzzCalendarContentUrl)).toHaveLength(3);
  expect(calendar("#星铁日历")).toBeUndefined();
});
