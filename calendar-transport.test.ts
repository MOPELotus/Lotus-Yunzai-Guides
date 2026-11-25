import { expect, test } from "bun:test";
import { calendarTransport } from "./calendar-data.ts";
const endpoint = "https://hkrpg-api.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnList";

test("公告日历与官方原图通用传输只读重试三次，保留匿名路由及取消", async () => {
  let calls = 0;
  const transport = Object.assign(async (_url: unknown, init?: RequestInit) => {
    calls++;
    expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(new Headers(init?.headers).has("Cookie")).toBe(false);
    if (calls === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    if (calls === 2) return new Response(null, { status: 502 });
    return Response.json({ retcode: 0, data: {} });
  }, { preconnect: fetch.preconnect });
  expect((await calendarTransport(transport)(endpoint)).status).toBe(200);
  expect(calls).toBe(3);
  const controller = new AbortController(); calls = 0;
  const cancelled = Object.assign(async () => {
    calls++; controller.abort(); throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
  }, { preconnect: fetch.preconnect });
  await expect(calendarTransport(cancelled, controller.signal)(endpoint)).rejects.toThrow();
  expect(calls).toBe(1);
});

test("公告日历永久拒绝及服务冷却不重试", async () => {
  for (const status of [403, 429, 503]) {
    let calls = 0;
    const transport = Object.assign(async () => {
      calls++; return new Response(null, { status, headers: status === 503 ? { "Retry-After": "60" } : {} });
    }, { preconnect: fetch.preconnect });
    expect((await calendarTransport(transport)(endpoint)).status).toBe(status);
    expect(calls).toBe(1);
  }
});
