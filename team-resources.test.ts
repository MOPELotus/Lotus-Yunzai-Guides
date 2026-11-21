import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { scheduledJobs } from "node-schedule";
import { CommandRegistry } from "../../lib/commands.ts";
import { createGuidesModule, startTeamResourceRefresh } from "./index.ts";
import { createTeamResources, guideSource } from "./team-resources.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
const directory = "Genshin/TeamGuides";

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
}

test("分批从源 Git 读取配队文件，完整后切换，损坏与断网保留上版", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-guides-resource-test-"));
  try {
    const upstream = join(root, "source");
    const fallback = join(root, "previous");
    const data = join(root, "data");
    const team = join(upstream, directory);
    const image = join(team, "茗血茶", "万达国际.png");
    await mkdir(join(team, "茗血茶"), { recursive: true });
    await mkdir(fallback);
    const index = `茗血茶: {万达国际: {alias: [万达], role: [达达利亚]}}
卡玛sei亚: {}
`;
    await writeFile(join(team, "teamGuides.yaml"), index);
    await writeFile(join(fallback, "teamGuides.yaml"), index);
    await writeFile(join(upstream, "ignored.js"), "throw Error('不应执行此文件');");
    await writeFile(image, PNG);
    git(upstream, "init", "--quiet", "--initial-branch=master", "--template=");
    git(upstream, "config", "user.name", "Fixture");
    git(upstream, "config", "user.email", "fixture@example.invalid");
    git(upstream, "config", "uploadpack.allowFilter", "true");
    git(upstream, "config", "uploadpack.allowAnySHA1InWant", "true");
    function commit(message: string) {
      git(upstream, "add", "--all");
      git(upstream, "commit", "--quiet", "-m", message);
    }
    commit("初次发布");
    const resources = createTeamResources({ root: data, fallback, source: pathToFileURL(upstream).href });
    expect(guideSource).toBe("https://gitee.com/Rrrrrrray/mora-plugin-res.git");
    expect(await resources.directory()).toBe(fallback);
    const pending = resources.refresh();
    expect(resources.refresh()).toBe(pending);
    expect(await pending).toBe("updated");
    let initial = await resources.directory();
    expect(await readdir(initial)).toEqual(expect.arrayContaining(["teamGuides.yaml", "茗血茶"]));
    expect(await readFile(join(initial, "茗血茶", "万达国际.png"))).toEqual(PNG);
    expect(await Bun.file(join(initial, "ignored.js")).exists()).toBe(false);
    expect(await resources.refresh()).toBe("current");
    expect(await resources.directory()).toBe(initial);

    await rm(join(initial, "茗血茶", "万达国际.png"));
    expect(await resources.refresh()).toBe("updated");
    initial = await resources.directory();
    expect(await readFile(join(initial, "茗血茶", "万达国际.png"))).toEqual(PNG);
    expect(await resources.refresh()).toBe("current");

    await writeFile(image, "损坏图片");
    commit("损坏发布");
    await expect(resources.refresh()).rejects.toThrow("上游配队文件不完整");
    expect(await resources.directory()).toBe(initial);
    expect(await readFile(join(initial, "茗血茶", "万达国际.png"))).toEqual(PNG);

    const nextImage = Buffer.concat([PNG, Buffer.from("更新")]);
    await writeFile(image, nextImage);
    commit("修复并更新");
    expect(await resources.refresh()).toBe("updated");
    const updated = await resources.directory();
    expect(updated).not.toBe(initial);
    expect(await readFile(join(updated, "茗血茶", "万达国际.png"))).toEqual(nextImage);
    expect(await readFile(join(initial, "茗血茶", "万达国际.png"))).toEqual(PNG);

    const registry = new CommandRegistry();
    registry.registerModule(createGuidesModule({ directory: fallback, resources }));
    const update = "#更新配队资源";
    const force = "#强制更新配队资源";
    const owner = { message_type: "terminal", isMaster: true } as const;
    for (const old of ["#更新摩拉资源", "#强制更新摩拉资源"]) {
      expect(await registry.dispatch(old, owner)).toBeUndefined();
      expect(await registry.dispatch(`${old} 参数`, owner)).toBeUndefined();
    }
    expect(await registry.dispatch(update, { ...owner, isMaster: false })).toContain("只有主人");
    expect(await registry.dispatch(`${update} 参数`, owner)).toBe(`请发送 ${update}。`);
    expect(await registry.dispatch(`${force} 参数`, owner)).toBe(`请发送 ${force}。`);
    expect(await registry.dispatch(update, owner)).toBe("配队资源已是最新。");
    expect(await registry.dispatch(force, owner)).toBe("配队资源已更新。");

    const latest = await resources.directory();
    await rename(upstream, upstream + "-offline");
    expect(await registry.dispatch(update, owner)).toBe("配队资源更新失败，仍使用已有资源。");
    expect(await resources.directory()).toBe(latest);
    expect((await readdir(data)).some((entry) => entry.startsWith(".refresh-"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("缺包启动触发更新，已安装时每天北京时间三点加随机延迟执行", async () => {
  let installed = false;
  const refresh = spyOn({ async run() { installed = true; return "current" as const; } }, "run");
  const handle = new AbortController();
  const jitter = spyOn(Math, "random").mockReturnValue(0);
  const existing = new Set(Object.keys(scheduledJobs));
  const stop = startTeamResourceRefresh({
    refresh, initialized: async () => installed, available: async () => installed,
    directory: async () => "", wait: async () => {},
  }, handle.signal);
  try {
    const name = Object.keys(scheduledJobs).find((key) => !existing.has(key) && key.startsWith("lotus-guides-team-refresh-"));
    const job = name && scheduledJobs[name];
    if (!job) throw new Error("自动更新任务未安装。");
    const next = job.nextInvocation();
    if (!next) throw new Error("未安排下次自动更新。");
    expect(new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).format(next.getTime())).toBe("03:00");
    await Bun.sleep(10);
    expect(refresh).toHaveBeenCalledTimes(1);
    job.invoke();
    await Bun.sleep(10);
    expect(refresh).toHaveBeenCalledTimes(2);
    handle.abort();
    expect(scheduledJobs[name]).toBeUndefined();
  } finally {
    handle.abort();
    await stop();
    jitter.mockRestore();
    refresh.mockRestore();
  }
});
