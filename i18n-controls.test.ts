import { expect, test } from "bun:test";
import { getLanguage, registerLanguage, setLanguage } from "../../packages/i18n/index.ts";
import { matchAkashaAbyss } from "./akasha-abyss.ts";
import { resolveGuideRole } from "./role-guide-input.ts";
import { indexedTeamImages } from "./team-guides.ts";
import catalog from "./i18n/zh-CN.json";

async function isolated(name: string) {
  if (Bun.env.LOTUS_I18N_CONTROL_CHILD === name) return false;
  const child = Bun.spawn([process.execPath, "test", "--test-name-pattern", name, import.meta.path], {
    env: { ...process.env, LOTUS_I18N_CONTROL_CHILD: name }, stdout: "pipe", stderr: "pipe",
  });
  const [status, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(output + errors);
  return true;
}

test("半区排序、作者目录及主角攻略标识不随显示语言变化", async () => {
  if (await isolated('半区排序、作者目录及主角攻略标识不随显示语言变化')) return;
  const previous = getLanguage();
  registerLanguage("en", { guides: Object.fromEntries(Object.keys(catalog.messages).map(key => [key, "translated:" + key])) });
  try {
    setLanguage("en");
    expect(matchAkashaAbyss("#虚空深渊下半队伍满星率2")).toEqual({ type: "teams", half: "下半", sort: "满星率", page: 2 });
    expect(resolveGuideRole("草主", "gs")).toEqual({ name: "草主" });
    expect(resolveGuideRole("毁灭主", "sr")).toMatchObject({ name: "物主", id: "8001" });
    expect(indexedTeamImages("茗血茶: {队伍: {alias: [], role: []}}\n卡玛sei亚: {}\n")).toEqual(["茗血茶/队伍.png"]);
  } finally { setLanguage(previous); }
});

test("非中文启动仍使用原攻略文件名和命令索引", async () => {
  // Isolate initialization-time labels from other tests that intentionally use Chinese.
  const base = new URL("../../", import.meta.url).href;
  const source = `
    import { registerLanguage, setLanguage } from ${JSON.stringify(base + "packages/i18n/index.ts")};
    import catalog from ${JSON.stringify(new URL("./i18n/zh-CN.json", import.meta.url).href)};
    import { mkdtemp, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    registerLanguage("en", { guides: Object.fromEntries(Object.keys(catalog.messages).map(key => [key, "translated:" + key])) });
    setLanguage("en");
    const { createStarRailGuideHistory } = await import(${JSON.stringify(new URL("./starrail-guide-history.ts", import.meta.url).href)});
    const { requiredAbyssReferences } = await import(${JSON.stringify(new URL("./abyss-references.ts", import.meta.url).href)});
    const root = await mkdtemp(join(tmpdir(), "lotus-i18n-guide-paths-"));
    const seen = [];
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X9uoAAAAASUVORK5CYII=", "base64");
    const transport = Object.assign(async input => {
      seen.push(decodeURIComponent(new URL(input instanceof Request ? input.url : input).pathname));
      return new Response(png);
    }, { preconnect: fetch.preconnect });
    try {
      const query = createStarRailGuideHistory({ cache: root, fetch: transport });
      const reply = await query("#星铁攻略");
      console.log(JSON.stringify({ seen, requiredAbyssReferences, hasReply: reply !== undefined }));
    } finally { await rm(root, { recursive: true, force: true }); }
  `;
  const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
  const [status, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(errors).toBe("");
  expect(status).toBe(0);
  const result = JSON.parse(output) as { seen: string[]; requiredAbyssReferences: string[]; hasReply: boolean };
  expect(result.hasReply).toBe(true);
  expect(result.seen).toHaveLength(7);
  expect(result.seen.every(path => /\/gl\/[^/]+\.jpg$/u.test(path) && !path.includes("translated"))).toBe(true);
  expect(result.seen.some(path => path.endsWith("/gl/毁灭.jpg"))).toBe(true);
  expect(result.requiredAbyssReferences.some(path => path.includes("translated"))).toBe(false);
  expect(result.requiredAbyssReferences.some(path => path.includes("history12"))).toBe(true);
});
