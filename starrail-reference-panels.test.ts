import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRoleReferences } from "./role-references.ts";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
const image = (name: string) => Buffer.concat([png, Buffer.from(name)]);
const part = (name: string) => ({ type: "image" as const, file: image(name) });

test("星铁参考面板使用原在位来源，缺图回退旧原图并可显式查历史", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-starrail-reference-"));
  const cache = join(root, "cache");
  const archive = "backup/plugins/StarRail-plugin";
  const requests: string[] = [];
  const transport = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.hostname).toBe("raw.githubusercontent.com");
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    const file = decodeURIComponent(url.pathname.split("/").at(-1)!);
    requests.push(file);
    return new Response(Uint8Array.from(image(file)));
  }, { preconnect: fetch.preconnect });
  async function put(path: string, value: string | Buffer) {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, value);
  }
  try {
    const empty = JSON.stringify({ checkedAt: Date.now(), files: [] });
    await put("cache/mora-reference/StarRail/帮助/index.json", empty);
    await put("cache/mora-reference/StarRail/符玄/index.json", empty);
    await put("cache/mora-reference/StarRail/丹恒/index.json", empty);
    await put("upstream/StarRail/Roles/RefStat/希儿.png", image("现行希儿"));
    await put(`${archive}/resources/srsr/希儿.jpg`, image("归档旧希儿"));
    await put(`${archive}/config/alias.yaml`, "丹恒: [旧列车纸鸢]\n");
    const search = createRoleReferences({ cache, settingsRoot: pathToFileURL(root + "/"), signal: new AbortController().signal,
      guideSnapshot: async () => ({ directory: join(root, "upstream"), checkedAt: Date.now() - 60_000 }), fetch: transport });
    expect(await search("*参考面板")).toContain("*希儿面板");
    expect(await search("*希儿参考面板")).toEqual([part("现行希儿")]);
    expect(await search("*1102参考面板")).toEqual([part("现行希儿")]);
    expect(await search("＊历史Seele参考面板")).toEqual(["星铁希儿参考面板（旧版历史资料）", part("归档旧希儿")]);
    expect(await search("sr旧列车纸鸢参考面板")).toEqual(["星铁丹恒参考面板（旧版历史资料）", part("丹恒.jpg")]);
    expect(await search("*历史开拓者·存护参考面板")).toContainEqual(part("开拓者•存护.jpg"));
    expect(await search("*参考面板帮助")).toEqual(expect.arrayContaining([part("help.jpg")]));
    expect(await search("*符玄参考面板")).toContain("暂无符玄");
    expect(await search("*历史符玄参考面板")).toContain("暂无符玄的旧版");
    for (const command of ["*参考面板2", "*希儿参考面板2", "*123456789希儿参考面板", "*查询其他人面板"]) {
      expect(await search(command)).toBeUndefined();
    }
    expect(requests).toEqual(["丹恒.jpg", "开拓者•存护.jpg", "help.jpg"]);
    expect(await readFile(join(root, archive, "resources/srsr/希儿.jpg"))).toEqual(image("归档旧希儿"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
