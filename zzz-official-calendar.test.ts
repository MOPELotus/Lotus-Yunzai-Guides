import { expect, test } from "bun:test";
import { createZzzCalendar } from "./calendar.ts";
import { calendarTime, zzzCalendarListUrl } from "./calendar-data.ts";
import { createZzzOfficialCalendar } from "./zzz-official-calendar.ts";

const asset = "https://sdk-webstatic.mihoyo.com/upload/ann/2026/11/12/official-calendar.png";
const nextAsset = "https://sdk-webstatic.mihoyo.com/upload/ann/2026/11/13/next-calendar.png";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
const image = { type: "image" as const, file: png };
const minute = 60_000;

function fixture() {
  const clock = { time: calendarTime("2026-11-13 10:00:00")! };
  const parameters = { list: true, detail: true, image: true, end: "2026-11-13 23:59:59", token: "1794428800_token",
    content: `<p><img data-src="https://wrong.invalid/tracker" src="${asset}"></p><img src="${nextAsset}">` };
  const requests: string[] = [];
  const mock = (async (input: string, init: RequestInit) => {
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    const url = new URL(input);
    requests.push(url.href);
    if (input === zzzCalendarListUrl) return parameters.list ? Response.json({ retcode: 0, data: {
      t: parameters.token, list: [{ list: [{ ann_id: 9, start_time: "2026-11-13 09:00:00", end_time: parameters.end }] }],
    } }) : new Response(null, { status: 503 });
    if (url.hostname === "announcement-static.mihoyo.com") return parameters.detail ? Response.json({ retcode: 0, data: {
      list: [
        { title: "活动公告", subtitle: "活动日历", content: `<img src="${nextAsset}">` },
        { ann_id: 9, title: "3.4版本活动日历", subtitle: "上半活动日历", content: parameters.content },
        { ann_id: 10, title: "另一张日历", subtitle: "活动日历", content: `<img src="${nextAsset}">` },
      ],
      pic_list: [{ title: "图片日历", subtitle: "活动日历", content: `<img src="${nextAsset}">` }],
    } }) : new Response(null, { status: 503 });
    expect(url.hostname).toBe("sdk-webstatic.mihoyo.com");
    return parameters.image ? new Response(png) : new Response(null, { status: 503 });
  }) as typeof fetch;
  return { clock, parameters, requests, mock, use: createZzzOfficialCalendar({ fetch: mock, now: () => clock.time }) };
}

test("绝区零 cal 只取原文字公告首图，沿用原 t 并复用同一进程请求", async () => {
  const { use, requests } = fixture();
  expect(await Promise.all([use("%cal"), use("#绝区零cal")])).toEqual([image, image]);
  expect(requests).toHaveLength(3);
  expect(new URL(requests[1]!).searchParams.get("t")).toBe("1794428800_token");
  expect(requests[2]).toBe(asset);
  for (const alias of ["％cal", "#zzzcal", "/ZZZcal", "绝区零cal", "#绝区零zzzcal"]) expect(await use(alias)).toEqual(image);
  for (const other of ["cal", "#cal", "*cal", "#星铁cal", "%cal列表", "%CAL", "#绝区零日历", "#绝区零日历列表"]) {
    expect(use(other)).toBeUndefined();
  }
  expect(requests).toHaveLength(3);
});

test("旧 cal 与动态日历分流，断线只复用未过期的原图", async () => {
  const { use, requests, parameters, clock } = fixture();
  parameters.end = "2026-11-13 11:00:00";
  parameters.token = "";
  expect(await use("%cal")).toEqual(image);
  expect(new URL(requests[1]!).searchParams.get("t")).toBe(String(clock.time));
  clock.time += 11 * minute;
  parameters.list = false;
  expect(await use("%cal")).toEqual(["暂时无法刷新，以下为上次取得的官方活动日历。", image]);
  clock.time += 49 * minute;
  expect(await use("%cal")).toBe("获取活动列表失败");
  const dynamicCalls: string[] = [];
  const failed = (async (input: string) => {
    dynamicCalls.push(input);
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  const calendar = createZzzCalendar({ fetch: failed });
  expect(await calendar("#绝区零日历列表")).toContain("官方活动公告");
  expect(dynamicCalls).toHaveLength(2);
  expect(dynamicCalls.every(input => !new URL(input).searchParams.has("t"))).toBe(true);
  expect(await calendar("#绝区零cal")).toBe("获取活动列表失败");
  expect(dynamicCalls).toHaveLength(3);
});

test("未发布、原图缺失、远端改版及失败回退不能发送旧图或陌生 CDN", async () => {
  const { use, requests, parameters, clock } = fixture();
  parameters.content = '<img src="https://wrong.invalid/fake.png">';
  expect(await use("%cal")).toBe("未找到活动日历图片");
  expect(requests.some(input => input.includes("wrong.invalid"))).toBe(false);
  parameters.content = "";
  clock.time += minute;
  expect(await use("%cal")).toBe("未找到活动日历");
  parameters.content = `<img src="${asset}">`;
  clock.time += minute;
  expect(await use("%cal")).toEqual(image);
  parameters.content = `<img src="${nextAsset}">`;
  parameters.image = false;
  clock.time += 11 * minute;
  expect(await use("%cal")).toContain("获取活动日历图片失败");
  clock.time += minute;
  parameters.detail = false;
  expect(await use("%cal")).toContain("获取活动日历失败");
});

test("绝区零官方原图按会话容量发原始字节，超限改给同一官方原图链接", async () => {
  const { use, requests, parameters, clock } = fixture();
  expect(await use("%cal", png.byteLength)).toEqual(image);
  expect(await use("%cal", png.byteLength - 1)).toContain(asset);
  expect(await use("%cal")).toEqual(image);
  expect(requests).toHaveLength(3);
  clock.time += 11 * minute;
  parameters.list = false;
  expect(await use("%cal", png.byteLength - 1)).toEqual([
    "暂时无法刷新，以下为上次取得的官方活动日历。",
    "当前会话无法发送这张官方原图，请打开原图链接。\n" + asset,
  ]);
});
