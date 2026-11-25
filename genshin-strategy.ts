import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
import { mkdir } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { lockFile } from "../../lib/file-lock.ts";
import { GuideSettingsError } from "./guide-configuration.ts";
import { readGuideFile, writeGuideFile } from "./role-image-files.ts";

// TRSS Genshin strategy.js at 0290a17 defines these permanent source numbers.
const sources = [
  { source: $t("genshin-strategy.text_3f1ba7ca9c"), collection_id: [2319292, 2319293, 2319295, 2319296, 2319299, 2319294, 2319298, 642956] },
  { source: $t("genshin-strategy.text_c1c0189bc9"), collection_id: [813033] },
  { source: $t("genshin-strategy.text_9496d42dc8"), collection_id: [341284] },
  { source: $t("genshin-strategy.text_a6eaba6ac9"), collection_id: [341523] },
  { source: $t("genshin-strategy.text_b4c6adf776"), collection_id: [1582613] },
  { source: $t("genshin-strategy.text_fe561c5a71"), collection_id: [22148] },
  { source: $t("genshin-strategy.text_26fbb37d49"), collection_id: [1812949] },
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
  $t("genshin-strategy.text_d6e1ae7557"),
  $t("genshin-strategy.text_4fc06b71e5"),
  $t("genshin-strategy.text_4595e76ae5"),
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
      const lock = await lockFile(join(directory, ".genshin-strategy.sqlite"), $t("genshin-strategy.text_e16b588498"));
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
