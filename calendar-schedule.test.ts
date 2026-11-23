import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { lockFile } from "../../lib/file-lock.ts";
import { createCalendarSchedule, prepareLegacyCalendar, type CalendarScheduleKind, type CalendarScheduleOptions } from "./calendar-schedule.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});

test("原版日历交还保持名单范围、转成字符串 ID 并拒绝不可表示的路由", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-calendar-export-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const snapshot = join(directory, "snapshot.json");
  const state = { version: 1, whiteList: [77, "78", 77], blackList: [77],
    tasks: [{ cron: "0 3 31 12 *", type: "G" }, { cron: "0 0 3 31 12 *", type: "G" }] };
  await writeFile(snapshot, JSON.stringify(state));
  const { counts, files } = await prepareLegacyCalendar(snapshot);
  expect(counts).toEqual({ whiteList: 2, blackList: 1, tasks: 1 });
  expect(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, JSON.parse(value)]))).toEqual({
    "AutoCalendarWhiteList.json": ["77", "78"],
    "AutoCalendarBlackList.json": ["77"],
    "AutoCalendarTasks.json": [state.tasks[0]],
  });
  for (const unsupported of [{ ...state, account: "99" },
    { ...state, tasks: [{ ...state.tasks[0], adapter: "milky" }] }]) {
    await writeFile(snapshot, JSON.stringify(unsupported));
    await expect(prepareLegacyCalendar(snapshot)).rejects.toThrow("旧版不能表示");
  }
});

async function fixture(overrides: Partial<CalendarScheduleOptions> = {}) {
  const path = await mkdtemp(join(tmpdir(), "lotus-calendar-schedule-"));
  cleanups.push(() => rm(path, { force: true, recursive: true }));
  const root = pathToFileURL(`${path}/`);
  const stateFile = join(path, "data/guides/calendar-schedule.json");
  const legacy = join(path, "plugins/example");
  const host = new AbortController();
  const owner = new AbortController();
  const jobs = new Map<string, () => Promise<void>>();
  const start = async (additional: Partial<CalendarScheduleOptions> = {}) => {
    const schedule = await createCalendarSchedule({
      root, signal: host.signal, lockFile,
      register(cron, type, run) {
        const key = `${type}:${cron}`;
        jobs.set(key, run);
        return () => { jobs.delete(key); };
      },
      async targets() { return []; }, async render() { return; },
      ...overrides, ...additional,
    });
    cleanups.push(schedule.stop);
    return schedule;
  };
  async function old(white: unknown, black: unknown, tasks: unknown) {
    await mkdir(legacy, { recursive: true });
    await Promise.all(Object.entries({ WhiteList: white, BlackList: black, Tasks: tasks }).map(([key, value]) =>
      writeFile(join(legacy, `AutoCalendar${key}.json`), JSON.stringify(value))));
  }
  return { stateFile, start, old, jobs, legacy, host, owner: { key: "scope", signal: owner.signal }, disconnect: () => owner.abort() };
}

test("默认没有任务且不生成数据，名单对话限同一授权会话并支持取消", async () => {
  const f = await fixture();
  const schedule = await f.start();
  expect(await schedule.handle("#定时任务表", f.owner)).toContain("暂无任务");
  expect(await schedule.handle("#定时添加群聊白名单")).toContain("只有主人");
  expect(f.jobs.size).toBe(0);
  await expect(readFile(f.stateFile)).rejects.toMatchObject({ code: "ENOENT" });

  expect(await schedule.handle("#定时添加群聊白名单", f.owner)).toContain("请发送群号");
  expect(await schedule.handle("77")).toBeUndefined();
  expect(await schedule.handle("77", { ...f.owner, key: "other group" })).toBeUndefined();
  expect(await schedule.handle("#星铁日历", f.owner)).toBeUndefined();
  expect(await schedule.handle("不是群号", f.owner)).toContain("请输入有效群号");
  expect(await schedule.handle("#取消", f.owner)).toContain("已取消");
  expect(await schedule.handle("77", f.owner)).toBeUndefined();

  await schedule.handle("#定时添加群聊黑名单", f.owner);
  f.disconnect();
  const reconnected = { ...f.owner, signal: new AbortController().signal };
  expect(await schedule.handle("77", reconnected)).toBeUndefined();
  await schedule.handle("#定时添加群聊白名单", reconnected);
  expect(await schedule.handle("77", reconnected)).toBe("已添加：77");
  const saved = JSON.parse(await readFile(f.stateFile, "utf8"));
  expect(saved).toEqual({ version: 1, whiteList: [77], blackList: [], tasks: [] });
});

test("兼容三个旧 JSON，拒绝坏 cron，同一任务五段六段只登记一次并保持原文件", async () => {
  const f = await fixture();
  await f.old([77, "78", 77], ["80"], [{ cron: "0 9 * * *", type: "*" }, { cron: "0 0 9 * * *", type: "*" }]);
  const schedule = await f.start();
  expect([...f.jobs.keys()]).toEqual(["*:0 9 * * *"]);
  expect(await schedule.handle("#定时群聊表", f.owner)).toBe("群聊列表：\n白名单：77, 78\n黑名单：80");
  expect(await schedule.handle('#定时添加任务 time="79 9 * * *" S', f.owner)).toContain("无效");
  expect(await schedule.handle('#定时添加任务 time="0 0 9 * * *" *', f.owner)).toContain("已存在");
  await expect(readFile(f.stateFile)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await schedule.handle('#定时添加任务 time="0  12 * * *" S', f.owner)).toContain("添加成功");
  expect([...f.jobs.keys()]).toEqual(["*:0 9 * * *", "S:0 12 * * *"]);
  const saved = JSON.parse(await readFile(f.stateFile, "utf8"));
  expect(saved).toEqual({ version: 1, whiteList: [77, 78], blackList: [80], tasks: [
    { cron: "0 9 * * *", type: "*" }, { cron: "0 12 * * *", type: "S" },
  ] });
  expect(await readFile(join(f.legacy, "AutoCalendarWhiteList.json"), "utf8")).toBe('[77,"78",77]');
  await schedule.stop();
  expect(f.jobs.size).toBe(0);
  await f.start();
  expect([...f.jobs.keys()]).toEqual(["*:0 9 * * *", "S:0 12 * * *"]);
});

test("并发读改写不丢名单，坏文件及链接均不会被覆盖", async () => {
  const f = await fixture();
  const left = await f.start();
  const right = await f.start();
  await left.handle("#定时添加群聊白名单", f.owner);
  await right.handle("#定时添加群聊黑名单", f.owner);
  expect(await Promise.all([left.handle("77", f.owner), right.handle("78", f.owner)])).toEqual(["已添加：77", "已添加：78"]);
  expect(await left.handle("#定时群聊表", f.owner)).toBe("群聊列表：\n白名单：77\n黑名单：78");
  await writeFile(f.stateFile, "{");
  expect(await left.handle('#定时添加任务 time="0 9 * * *" G', f.owner)).toContain("暂不可用");
  expect(await readFile(f.stateFile, "utf8")).toBe("{");
  const target = `${f.stateFile}.kept`;
  await writeFile(target, "不允许改动");
  await rm(f.stateFile);
  await symlink(target, f.stateFile);
  expect(await left.handle('#定时添加任务 time="0 9 * * *" G', f.owner)).toContain("暂不可用");
  expect(await readFile(target, "utf8")).toBe("不允许改动");
});

test("黑名单覆盖白名单，每个定时任务只渲染一次，群间限速且未确认不重发", async () => {
  const trace: Array<string | number> = [];
  const f = await fixture({
    async targets(ids) {
      expect(ids).toEqual([77, 79]);
      return [77, 78, 77, 79, 80].map((groupId) => ({ groupId, async send(message) {
        expect(message).toEqual([{ type: "image", file: new Uint8Array([1]) }, { type: "image", file: new Uint8Array([2]) }]);
        trace.push(groupId);
        if (groupId === 77) throw new Error("未确认");
        return "confirmed";
      } }));
    },
    async render(type) {
      trace.push(type);
      return [{ type: "image", file: new Uint8Array([1]) }, { type: "image", file: new Uint8Array([2]) }];
    },
    async wait(milliseconds) {
      expect(milliseconds).toBeGreaterThan(0);
      expect(milliseconds).toBeLessThanOrEqual(5000);
      trace.push("wait");
    },
    report(stage, outcome) { trace.push(`${stage}:${outcome}`); },
  });
  await f.old([77, 78, 79], [78], [{ cron: "0 9 * * *", type: "*" }]);
  await f.start();
  const run = f.jobs.get("*:0 9 * * *")!;
  await Promise.all([run(), run()]);
  expect(trace).toEqual(["*", 77, "send:unknown", "wait", 79]);
});

test("停机等待已发出的消息回执，取消在队列中两种任务的后续发送", async () => {
  const starting = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const sends: number[] = [];
  const rendered: CalendarScheduleKind[] = [];
  const f = await fixture({
    async targets() {
      return [77, 79].map(groupId => ({ groupId, async send() {
        sends.push(groupId);
        starting.resolve();
        await finish.promise;
        return "confirmed";
      } }));
    },
    async render(type) { rendered.push(type); return "calendar"; },
  });
  await f.old([77, 79], [], [{ cron: "0 9 * * *", type: "G" }, { cron: "0 9 * * *", type: "S" }]);
  const schedule = await f.start();
  const work = Promise.all([...f.jobs.values()].map((run) => run()));
  await starting.promise;
  f.host.abort();
  let stopped = false;
  const finishing = schedule.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  finish.resolve();
  await Promise.all([work, finishing]);
  expect(sends).toEqual([77]);
  expect(rendered).toEqual(["G"]);
  expect(f.jobs.size).toBe(0);
});

test("定时日历按接收会话上限生成并复用同上限版本", async () => {
  const rendered: (number | undefined)[] = [];
  const sent: [number, string][] = [];
  const limits = new Map<number, number>([[79, 17], [81, 17], [82, 6]]);
  const f = await fixture({
    async targets() {
      return [77, 79, 81, 82].map(groupId => ({
        groupId, inlineImageByteLimit: limits.get(groupId), async send(message) {
          sent.push([groupId, String(message)]);
          return "confirmed";
        },
      }));
    },
    async render(type, _active, limit) {
      expect(type).toBe("*");
      rendered.push(limit);
      return limit === 6 ? "日历文字" : String(limit ?? "不限");
    },
    async wait() {},
  });
  await f.old([77, 79, 81, 82], [], [{ cron: "0 9 * * *", type: "*" }]);
  await f.start();
  await f.jobs.get("*:0 9 * * *")!();
  expect(rendered).toEqual([undefined, 17, 6]);
  expect(sent).toEqual([[77, "不限"], [79, "17"], [81, "17"], [82, "日历文字"]]);
});
