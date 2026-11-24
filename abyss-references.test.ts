import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAbyssReferences, requiredAbyssReferences } from "./abyss-references.ts";
import { createOriginalRoleResources } from "./original-role-resources.ts";

const signature = Buffer.from("ffd8ffe000104a464946000101000001", "hex");
const image = (path: string) => Buffer.concat([signature, Buffer.from(path)]);
const reply = (path: string) => ({ type: "image" as const, file: image(path) });

test.skipIf(!Bun.which("git"))("旧深渊参考从原 Git 读取 JPG 单间、版本原图和作者阵容，避开其他挑战查询", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-abyss-reference-"));
  const upstream = join(root, "upstream");
  const legacy = join(root, "legacy");
  const controller = new AbortController();
  const [floor11, floor12_1, floor12_2, floor12_3, team, opening11, opening12] = requiredAbyssReferences;
  const versionImage = "Genshin/Abyss/Version/4.8/4.8-12.png";
  const unrelated = "Genshin/Abyss/Version/4.8/5.8-12.png";
  async function put(directory: string, file: string) {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await writeFile(join(directory, file), image(file));
  }
  function git(...args: string[]) {
    const result = Bun.spawnSync(["git", ...args], { cwd: upstream, stderr: "pipe" });
    if (result.exitCode) throw Error(result.stderr.toString());
  }
  try {
    const oldWrongExtension = floor12_1.replace(/\.jpg$/u, ".png");
    await Promise.all([...requiredAbyssReferences, oldWrongExtension, versionImage, unrelated,
      "Genshin/Abyss/Teams/其他作者/4.8.png"].map(path => put(upstream, path)));
    await put(legacy, floor12_1);
    await mkdir(join(upstream, "gs"));
    await rename(join(upstream, "Genshin", "Abyss"), join(upstream, "gs", "Abyss"));
    git("init", "--quiet", "--initial-branch=master", "--template=");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@invalid");
    git("config", "uploadpack.allowFilter", "true");
    git("config", "uploadpack.allowAnySHA1InWant", "true");
    git("add", "--all");
    git("commit", "--quiet", "-m", "原深渊参考图");
    const make = (directory: string) => createOriginalRoleResources({ root: join(root, directory), cache: join(root, "query"),
      fallbacks: [legacy], signal: controller.signal, source: pathToFileURL(upstream).href, scope: "abyss" });
    const resources = make("store");
    const query = createAbyssReferences(resources, [legacy], true);
    expect(await query("#历代12-1")).toEqual(reply(floor12_1));
    expect(await resources.current()).toBeUndefined();
    const full = ["历代深渊12层最低输出量", ...[floor11, floor12_1, floor12_2, floor12_3].map(reply)];
    expect(await query("#历代12层")).toEqual({ type: "forward", nodes: full });
    expect(await query("历代12-2最低输出量")).toEqual(reply(floor12_2));
    expect(await query("#历代12-3最低输出量")).toEqual(reply(floor12_3));
    expect(await query("#4.8深渊阵容")).toEqual(reply(team));
    expect(await query("#4.8深渊阵容参考")).toEqual(reply(team));
    expect(await query("4.8深渊阵容推荐")).toEqual(reply(team));
    const opening = ["原神1.0深渊", reply(opening11), reply(opening12)];
    expect(await query("#1.0深渊")).toEqual({ type: "forward", nodes: opening });
    expect(await query("#原神1.0深渊")).toEqual({ type: "forward", nodes: opening });
    expect(await query("#4.8深渊")).toEqual(reply(versionImage));
    expect(await createAbyssReferences(resources, [], false)("1.0深渊")).toEqual(opening);
    expect(await query("#9.9深渊")).toBeUndefined();
    expect(await query("#5.3深渊阵容")).toBe("暂无5.3深渊阵容");
    expect(await createAbyssReferences(resources, [], false)("#历代12层最低输出量")).toEqual(full);
    const snapshot = (await resources.current())!.directory;
    expect(await Bun.file(join(snapshot, oldWrongExtension)).exists()).toBe(false);
    expect(await Bun.file(join(snapshot, unrelated)).exists()).toBe(false);
    expect(await Bun.file(join(snapshot, "Genshin/Abyss/Teams/其他作者/4.8.png")).exists()).toBe(false);
    for (const command of ["#历代12", "#历代12-4", "#4.8阵容", "#星铁3.0混沌", "*3.0混沌", "#星铁4.8深渊阵容", "#挑战图鉴 原神 深渊 125"]) {
      expect(query(command)).toBeUndefined();
    }
    await rm(join(snapshot, opening11));
    expect(await resources.initialized()).toBe(false);
    expect(await query("#1.0深渊")).toEqual({ type: "forward", nodes: opening });
    expect(await resources.initialized()).toBe(true);
    await rename(upstream, upstream + "-offline");
    expect(await query("#4.8深渊阵容")).toEqual(reply(team));
    expect(await query("#1.0深渊")).toEqual({ type: "forward", nodes: opening });
    const unavailable = createAbyssReferences(make("offline"), [legacy], true);
    const partial = await unavailable("#历代12层");
    expect(partial).toEqual(["历代深渊12层最低输出量", expect.stringContaining("历代12-2最低输出量"), reply(floor12_1)]);
  } finally {
    controller.abort();
    await rm(root, { recursive: true, force: true });
  }
}, 12_000);
