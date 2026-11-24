import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createOriginalRoleResources } from "./original-role-resources.ts";
import { moraSourcePath } from "./role-guide-input.ts";
import { guideBlobId } from "./team-resources.ts";

const git = Bun.which("git");
const png = Buffer.from("89504e470d0a1a0a000000000000000001", "hex");
const image = (label: string) => Buffer.concat([png, Buffer.from(label)]);

test.skipIf(!git || process.platform === "win32")("角色首装复用原目录和查询缓存，续传与日更只取仍缺的原图", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-original-roles-"));
  const savedPath = Bun.env.PATH;
  const source = join(root, "source");
  const legacy = join(root, "old");
  const cache = join(root, "query-cache");
  const store = join(root, "store");
  const trace = join(root, "requests");
  const fail = join(root, "outage");
  const first = join(root, "first");
  const supported = ["Genshin/Roles/Guides/作者/钟离.png", "Genshin/Roles/RefStat/钟离.png",
    "Genshin/Roles/YieldCurve/钟离.png", "StarRail/Roles/Guides/作者/流萤.png", "StarRail/Roles/RefStat/流萤.png",
    ...Array.from({ length: 8 }, (_, i) => `ZenlessZoneZero/Roles/Guides/作者/代理人${i}.png`)];
  async function put(file: string, bytes: string | Buffer) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  function run(...args: string[]) {
    const result = Bun.spawnSync([git!, ...args], { cwd: source, stderr: "pipe" });
    if (result.exitCode) throw new Error(result.stderr.toString());
  }
  const controller = new AbortController();
  try {
    for (const [index, path] of supported.entries()) await put(join(source, index % 2 ? moraSourcePath(path) : path), image(path));
    await put(join(source, "Genshin/Roles/RefStat/RefNotes.yaml"), "钟离: {}\n");
    await put(join(source, "Genshin/Abyss/unrelated.png"), image("unrelated"));
    await put(join(legacy, supported[0]!), image(supported[0]!));
    const queried = image(supported[1]!);
    await put(join(cache, "mora-reference/Genshin/钟离", guideBlobId(queried)), queried);
    run("init", "--quiet", "--initial-branch=master", "--template=");
    run("config", "user.name", "Test");
    run("config", "user.email", "test@invalid");
    run("config", "uploadpack.allowFilter", "true");
    run("config", "uploadpack.allowAnySHA1InWant", "true");
    run("add", "--all");
    run("commit", "--quiet", "-m", "fixture");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), `#!/bin/sh
for arg do
  if [ "$arg" = "--stdin" ]; then
    if [ -f '${fail}' ] && [ -f '${first}' ]; then exit 1; fi
    req='${trace}'.$$
    cat > "$req"
    cat "$req" >> '${trace}'
    touch '${first}'
    '${git}' "$@" < "$req"
    result=$?
    rm -f "$req"
    exit "$result"
  fi
done
exec '${git}' "$@"
`, { mode: 0o700 });
    Bun.env.PATH = [bin, savedPath].join(delimiter);
    const make = () => createOriginalRoleResources({ root: store, cache, fallbacks: [legacy], source: pathToFileURL(source).href,
      signal: controller.signal });
    const initial = make();
    await writeFile(fail, "");
    await expect(initial.refresh()).rejects.toThrow("Git -c");
    expect(await initial.current()).toBeUndefined();
    expect(await make().initialized()).toBe(false);
    const sent = (await readFile(trace, "utf8")).trim().split("\n");
    expect(sent.length).toBeGreaterThan(0);
    await rm(fail);
    const resumed = make();
    expect(await resumed.refresh()).toBe("updated");
    const installed = (await resumed.current())!.directory;
    for (const path of supported) expect(await readFile(join(installed, path))).toEqual(image(path));
    expect(await Bun.file(join(installed, "Genshin/Abyss/unrelated.png")).exists()).toBe(false);
    const requested = (await readFile(trace, "utf8")).trim().split("\n");
    expect(new Set(requested).size).toBe(requested.length);
    expect(requested).not.toContain(guideBlobId(image(supported[0]!)));
    expect(requested).not.toContain(guideBlobId(queried));
    expect(await make().initialized()).toBe(true);

    const updated = image("更新原图");
    await put(join(source, moraSourcePath(supported[0]!)), updated);
    await put(join(source, "Genshin/Abyss/unrelated.png"), image("irrelevant"));
    run("add", "--all");
    run("commit", "--quiet", "-m", "update");
    expect(await resumed.refresh()).toBe("updated");
    expect((await readFile(trace, "utf8")).trim().split("\n").slice(requested.length)).toEqual([guideBlobId(updated)]);
    expect(await readFile(join((await resumed.current())!.directory, supported[0]!))).toEqual(updated);
    expect(await readFile(join(installed, supported[0]!))).toEqual(image(supported[0]!));
    expect(await resumed.refresh()).toBe("current");
    const current = (await resumed.current())!.directory;
    const missing = supported[2]!;
    const corrupted = supported[3]!;
    const beforeRepair = await readFile(trace, "utf8");
    await rm(join(current, missing));
    await writeFile(join(current, corrupted), image("原作者图像的头部相同但哈希已变"));
    expect(await resumed.refresh()).toBe("updated");
    const repaired = (await resumed.current())!.directory;
    expect(await readFile(join(repaired, missing))).toEqual(image(missing));
    expect(await readFile(join(repaired, corrupted))).toEqual(image(corrupted));
    expect((await readFile(trace, "utf8")).slice(beforeRepair.length).trim()).toBe(guideBlobId(image(corrupted)));
    expect(await resumed.refresh()).toBe("current");
  } finally {
    controller.abort();
    if (savedPath === undefined) delete Bun.env.PATH;
    else Bun.env.PATH = savedPath;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
