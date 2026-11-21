import { dirname, basename } from "node:path";
import { readGuideFile, writeGuideFile } from "./role-image-files.ts";

// TRSS Genshin strategy.js at 0290a17 defines these permanent source numbers.
const sources = [
  { source: "西风驿站", collection_id: [2319292, 2319293, 2319295, 2319296, 2319299, 2319294, 2319298, 642956] },
  { source: "原神观测枢", collection_id: [813033] },
  { source: "派蒙喵喵屋", collection_id: [341284] },
  { source: "OH是姜姜呀", collection_id: [341523] },
  { source: "曉K", collection_id: [1582613] },
  { source: "坤易", collection_id: [22148] },
  { source: "婧枫赛赛", collection_id: [1812949] },
] as const;

export function genshinStrategySource(number: number) {
  return sources[number - 1];
}

export const genshinStrategyHelp = [
  "原神编号攻略",
  "发送 #心海攻略4 指定来源，或用 #更新早柚攻略4 刷新该来源。",
  "机器人主人可用 #设置默认攻略1 设置仅在普通攻略没有图时使用的来源。",
  ...sources.map(({ source }, index) => `${index + 1}. ${source}`),
].join("\n");

function validSource(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= sources.length;
}

export function createGenshinStrategyPreference(file: string, legacy?: string) {
  async function read(path: string, parse: (content: string) => unknown) {
    const bytes = await readGuideFile(dirname(path), basename(path), 64 * 1024);
    if (!bytes) return;
    try {
      const value = (parse(bytes.toString("utf8")) as { defaultSource?: unknown } | null)?.defaultSource;
      if (validSource(value)) return value;
    } catch {}
  }

  return {
    async get() {
      return await read(file, JSON.parse) ?? (legacy ? await read(legacy, Bun.YAML.parse) : undefined) ?? 1;
    },
    async set(source: number) {
      if (!validSource(source)) throw new Error("攻略来源编号无效。");
      await writeGuideFile(file, JSON.stringify({ defaultSource: source }) + "\n");
    },
  };
}
