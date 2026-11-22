import { mkdir } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { lockFile } from "../../lib/file-lock.ts";
import { GuideSettingsError } from "./guide-configuration.ts";
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

export function genshinStrategyNumber(author: { readonly source: string; readonly collection_id: readonly number[] }) {
  const index = sources.findIndex(({ source, collection_id }) => source === author.source &&
    collection_id.length === author.collection_id.length && collection_id.every((id, offset) => id === author.collection_id[offset]));
  if (index >= 0) return index + 1;
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

  async function get() {
    return await read(file, JSON.parse) ?? (legacy ? await read(legacy, Bun.YAML.parse) : undefined) ?? 1;
  }
  return {
    get,
    async set(source: number, { previous, canWrite }: { readonly previous?: number; readonly canWrite?: () => boolean } = {}) {
      if (!validSource(source)) throw new GuideSettingsError("input");
      if (canWrite && !canWrite()) throw new GuideSettingsError("permission");
      const directory = dirname(file);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const lock = await lockFile(join(directory, ".genshin-strategy.sqlite"), "原神攻略设置");
      try {
        const latest = await get();
        if (previous !== undefined && latest !== previous) throw new GuideSettingsError("conflict");
        if (canWrite && !canWrite()) throw new GuideSettingsError("permission");
        if ((previous === undefined || latest !== source) &&
            !await writeGuideFile(file, JSON.stringify({ defaultSource: source }) + "\n", canWrite)) {
          throw new GuideSettingsError("permission");
        }
        return source;
      } finally {
        lock.close();
      }
    },
  };
}
