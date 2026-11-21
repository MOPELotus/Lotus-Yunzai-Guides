import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bannerFiles, createBannerTables } from "./banner-tables.ts";
import { createOriginalRoleResources } from "./original-role-resources.ts";

const signature = Buffer.from("89504e470d0a1a0a000000000000000001", "hex");
const image = (file: string) => Buffer.concat([signature, Buffer.from(file)]);
const reply = (file: string) => ({ type: "image" as const, file: image(file) });
const forward = (...files: readonly string[]) => ({ type: "forward" as const, nodes: ["复刻时间表", ...files.map(reply)] });

test.skipIf(!Bun.which("git"))("复刻表保留旧游戏过滤、节点顺序和单图，并在源变化或断连时保持已装快照", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-banner-tables-"));
  const upstream = join(root, "source");
  const origin = join(root, "origin");
  const legacy = join(root, "legacy");
  const controller = new AbortController();
  function git(...args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: upstream, stderr: "pipe" });
    if (result.exitCode) throw new Error(result.stderr.toString());
  }
  function commit(message: string) {
    git("add", "--all");
    git("commit", "--quiet", "-m", message);
  }
  try {
    await mkdir(join(upstream, "Banners"), { recursive: true });
    await mkdir(join(legacy, "Banners"), { recursive: true });
    for (const name of bannerFiles) {
      await writeFile(join(upstream, "Banners", name), image(name));
      await writeFile(join(legacy, "Banners", name), image(name));
    }
    await writeFile(join(upstream, "Banners", "无关.png"), image("未接入"));
    await writeFile(join(upstream, "unrelated.txt"), "无关");
    git("init", "--quiet", "--initial-branch=master", "--template=");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@invalid");
    git("config", "uploadpack.allowFilter", "true");
    git("config", "uploadpack.allowAnySHA1InWant", "true");
    commit("旧复刻表");
    const resources = createOriginalRoleResources({ root: origin, cache: join(root, "cache"), fallbacks: [legacy],
      source: pathToFileURL(upstream).href, signal: controller.signal, banners: true });
    const fallback = createBannerTables(resources, [legacy], true);
    expect(await fallback("#复刻表")).toEqual(forward(...bannerFiles));
    expect(await resources.current()).toBeUndefined();
    const cold = createBannerTables(resources, [], true);
    expect(await cold("#星铁光锥复刻表")).toEqual(reply(bannerFiles[0]));
    const current = (await resources.current())!.directory;
    expect((await readdir(join(current, "Banners"))).sort()).toEqual([...bannerFiles].sort());
    expect(await Bun.file(join(current, "unrelated.txt")).exists()).toBe(false);
    expect(await resources.initialized()).toBe(true);
    expect(await cold("#原神复刻表")).toEqual(forward(...bannerFiles));
    expect(await cold("复刻表")).toEqual(forward(...bannerFiles));
    expect(await cold("#角色复刻表")).toEqual(forward(bannerFiles[1], bannerFiles[3]));
    expect(await cold("#星铁武器复刻表")).toEqual(reply(bannerFiles[0]));
    expect(await cold("#原神光锥复刻表")).toEqual(reply(bannerFiles[0]));
    expect(await cold("#星铁复刻表")).toEqual(forward(bannerFiles[0], bannerFiles[1]));
    expect(await cold("#芙宁娜复刻")).toBeUndefined();
    expect(await cold("#芙宁娜卡池")).toBeUndefined();
    expect(await cold("#绝区零复刻表")).toBeUndefined();
    const straight = createBannerTables(resources, [], false);
    expect(await straight("#武器复刻表")).toEqual(["复刻时间表", reply(bannerFiles[0]), reply(bannerFiles[2])]);

    const changed = join(upstream, "Banners", bannerFiles[3]);
    await writeFile(changed, image("新版角色"));
    commit("更新角色图");
    expect(await resources.refresh()).toBe("updated");
    const updated = (await resources.current())!.directory;
    expect(updated).not.toBe(current);
    expect(await readFile(join(updated, "Banners", bannerFiles[3]))).toEqual(image("新版角色"));
    expect(await cold("#角色复刻表")).toEqual(forward(bannerFiles[1], "新版角色"));
    await rm(changed);
    commit("缺图");
    await expect(resources.refresh()).rejects.toThrow("清单不完整");
    await rename(upstream, upstream + "-offline");
    await expect(resources.refresh()).rejects.toThrow("Git fetch");
    expect((await resources.current())!.directory).toBe(updated);
    expect(await cold("#角色复刻表")).toEqual(forward(bannerFiles[1], "新版角色"));
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
