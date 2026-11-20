import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRoleResourcePack } from "./role-resource-pack.ts";

const git = Bun.which("git");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
const image = (label: string) => Buffer.concat([png, Buffer.from(label)]);

test.skipIf(!git || process.platform === "win32")("旧角色图和过期原图可即时读取，冷角色仍等待原仓库", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-role-cache-"));
  const upstream = join(root, "upstream");
  const fallback = join(root, "previous");
  const cache = join(root, "current");
  const marker = join(root, "release");
  const index = join(cache, "Genshin", "钟离", "index.json");
  const controller = new AbortController();
  const originalPath = Bun.env.PATH;
  const tracked: Promise<unknown>[] = [];
  async function put(file: string, bytes: string | Buffer) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  try {
    await put(join(fallback, "Genshin/Roles/Guides/作者/钟离.png"), image("旧攻略"));
    await put(join(fallback, "Genshin/Roles/RefStat/RefNotes.yaml"), "{}\n");
    await put(join(upstream, "Genshin/Roles/Guides/作者/钟离.png"), image("新攻略"));
    await put(join(upstream, "Genshin/Roles/RefStat/钟离.png"), image("新进阶"));
    for (const args of [["init", "--quiet", "-b", "master"], ["add", "--all"],
      ["-c", "user.name=Test", "-c", "user.email=test@invalid", "commit", "--quiet", "-m", "fixture"]]) {
      const result = Bun.spawnSync([git!, ...args], { cwd: upstream, stderr: "pipe" });
      if (result.exitCode) throw new Error(result.stderr.toString());
    }
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), `#!/bin/sh
for arg do
  if [ "$arg" = "--bare" ]; then
    while [ ! -f "${marker}" ]; do sleep 0.02; done
  fi
done
exec "${git}" "$@"
`, { mode: 0o700 });
    Bun.env.PATH = [bin, originalPath].join(delimiter);
    const options = { fallback: [join(root, "missing"), fallback], upstream: pathToFileURL(upstream).href, signal: controller.signal };
    const packs = createRoleResourcePack({ ...options, root: cache });
    const refs = createRoleResourcePack({ ...options, root: join(root, "refs"), references: true });
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      expect(await packs("gs", "钟离", false)).toEqual([{ source: "作者", bytes: image("旧攻略") }]);
      expect(await packs("gs", "钟离", false)).toEqual([{ source: "作者", bytes: image("旧攻略") }]);
      expect(controller.signal.aborted).toBe(false);
      expect(await Bun.file(index).exists()).toBe(false);
    } finally {
      clearTimeout(timer);
    }
    const download = refs("gs", "钟离", false);
    const refresh = packs("gs", "钟离", true);
    tracked.push(download, refresh);
    await writeFile(marker, "");
    expect(await download).toEqual([{ source: "RefStat:钟离.png", bytes: image("新进阶") }]);
    expect(await refresh).toEqual([{ source: "作者", bytes: image("新攻略") }]);

    const meta = JSON.parse(await readFile(index, "utf8"));
    await writeFile(index, JSON.stringify({ ...meta, checkedAt: 0 }));
    await rename(upstream, upstream + "-offline");
    expect(await packs("gs", "钟离", false)).toEqual([{ source: "作者", bytes: image("新攻略") }]);
    expect(await packs("gs", "钟离", true)).toEqual([{ source: "作者", bytes: image("新攻略") }]);
  } finally {
    controller.abort();
    await writeFile(marker, "");
    await Promise.allSettled(tracked);
    if (originalPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
