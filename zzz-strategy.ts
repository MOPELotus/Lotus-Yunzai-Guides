import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CommandReply } from "../../lib/commands.ts";
import type { MessageSegment } from "../../lib/messages.ts";
import { lockFile } from "../../lib/file-lock.ts";
import type { createRoleGuideCollections } from "./role-guide-collections.ts";
import type { createRoleGuideCache } from "./role-guide-cache.ts";
import { guideKey, safeGuideName } from "./role-guide-input.ts";
import { GuideSettingsError } from "./guide-configuration.ts";
import { readGuideFile, readGuideImage, writeGuideFile } from "./role-image-files.ts";

// ZZZ-Plugin dist/lib/guides.js, 2057599. Public MiYouShe ZZZ collections in source-number order.
const sources = [
  { source: $t("zzz-strategy.text_1acdcd6272"), collection_id: [2712859] },
  { source: $t("zzz-strategy.text_b86b8f6f77"), collection_id: [2727116] },
  { source: $t("zzz-strategy.text_8176f01698"), collection_id: [2721968] },
  { source: $t("zzz-strategy.text_adc4aaf292"), collection_id: [2724610] },
  { source: $t("zzz-strategy.text_a7e9bb4364"), collection_id: [2722266] },
  { source: $t("zzz-strategy.text_b4fa8f0b66"), collection_id: [2723586] },
  { source: $t("zzz-strategy.text_a647fad4b7"), collection_id: [2716049] },
] as const;

const help = [
  $t("zzz-strategy.text_5387cf83b1"),
  $t("zzz-strategy.text_5fe2e46ce8"),
  $t("zzz-strategy.text_1492f10d0c"),
  ...sources.map(({ source }, index) => `${index + 1}. ${source}`),
].join("\n");
const prefix = /^(?:[#%％/]?(?:绝区零|zzz)|[%％])/iu;
const settingsFile = "zzz-strategy.json";
const settingsDefaults = { default_guide: 1, max_forward_guides: 4 };
type Settings = typeof settingsDefaults;
type GuideReply = string | Extract<MessageSegment, { type: "image" }>;

function validInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= sources.length;
}

async function object(root: string | undefined, file: string, parse: (content: string) => unknown) {
  const bytes = root && await readGuideFile(root, file, 64 * 1024);
  if (!bytes) return {};
  try {
    const result = parse(bytes.toString("utf8"));
    if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>;
  } catch {}
  return {};
}

function configValues(value: Record<string, unknown>): Partial<Settings> {
  const { default_guide: defaultGuide, max_forward_guides: maxForwardGuides } = value;
  const source = defaultGuide === "all" ? 0 : configNumber(defaultGuide);
  const maximum = configNumber(maxForwardGuides);
  return {
    ...(validInteger(source, 0) ? { default_guide: source } : {}),
    ...(validInteger(maximum, 1) ? { max_forward_guides: maximum } : {}),
  };
}

function configNumber(value: unknown) {
  return typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
}

export const zzzStrategyOptions = [
  { value: 0, label: $t("zzz-strategy.text_9f357adb61") },
  ...sources.map((author, index) => ({ value: index + 1, label: `${index + 1} · ${author.source}` })),
];

export function createZzzStrategySettings(options: { readonly cache: string; readonly legacyRoot?: string }) {
  async function readValues(): Promise<{ effective: Settings; current: Partial<Settings> }> {
    const [defaults, legacy, current] = await Promise.all([
      object(options.legacyRoot, "defSet/guide.yaml", Bun.YAML.parse),
      object(options.legacyRoot, "config/guide.yaml", Bun.YAML.parse),
      object(options.cache, settingsFile, JSON.parse),
    ]);
    const saved = configValues(current);
    return { effective: { ...settingsDefaults, ...configValues(defaults), ...configValues(legacy), ...saved }, current: saved };
  }

  return {
    async read() { return (await readValues()).effective; },
    async write(patch: Partial<Settings>, { previous, canWrite }: {
      readonly previous?: Settings; readonly canWrite?: () => boolean;
    } = {}) {
      for (const [key, value] of Object.entries(patch)) {
        if (!(key === "default_guide" ? validInteger(value, 0) : key === "max_forward_guides" && validInteger(value, 1))) {
          throw new GuideSettingsError("input");
        }
      }
      if (canWrite && !canWrite()) throw new GuideSettingsError("permission");
      await mkdir(options.cache, { recursive: true, mode: 0o700 });
      const lock = await lockFile(join(options.cache, ".zzz-strategy.sqlite"), $t("zzz-strategy.text_5c3e532279"));
      try {
        const { effective, current } = await readValues();
        if (previous && (previous.default_guide !== effective.default_guide ||
          previous.max_forward_guides !== effective.max_forward_guides)) throw new GuideSettingsError("conflict");
        if (canWrite && !canWrite()) throw new GuideSettingsError("permission");
        const changed = previous ? {
          ...(patch.default_guide !== undefined && patch.default_guide !== effective.default_guide &&
            { default_guide: patch.default_guide }),
          ...(patch.max_forward_guides !== undefined && patch.max_forward_guides !== effective.max_forward_guides &&
            { max_forward_guides: patch.max_forward_guides }),
        } : patch;
        if (Object.keys(changed).length &&
            !await writeGuideFile(join(options.cache, settingsFile), JSON.stringify({ ...current, ...changed }) + "\n", canWrite)) {
          throw new GuideSettingsError("permission");
        }
        return { ...effective, ...changed };
      } finally {
        lock.close();
      }
    },
  };
}

export function createZzzStrategy(options: {
  readonly cache: string;
  readonly legacyResources?: string;
  readonly legacyRoot?: string;
  readonly archivedResources?: string;
  readonly archivedRoot?: string;
  readonly collections: ReturnType<typeof createRoleGuideCollections>;
  readonly readCollectionImage: ReturnType<typeof createRoleGuideCache>;
  operation(key: string, update: boolean, load: () => Promise<GuideReply>, error: string): Promise<GuideReply>;
}) {
  const { read: settings, write } = createZzzStrategySettings(options);

  function set(key: keyof Settings, value: number) {
    return write({ [key]: value });
  }

  async function canonicalName(query: string) {
    const key = guideKey(query);
    for (const root of [options.legacyRoot, options.archivedRoot]) {
      for (const file of ["config/alias.yaml", "defSet/alias.yaml"]) {
        const aliases = await object(root, file, Bun.YAML.parse);
        for (const [name, names] of Object.entries(aliases)) {
          if (safeGuideName(name) && (guideKey(name) === key || Array.isArray(names) &&
            names.some((alias) => typeof alias === "string" && guideKey(alias) === key))) return name;
        }
      }
    }
    return query;
  }

  function one(name: string, number: number, update: boolean): Promise<GuideReply> {
    const author = sources[number - 1]!;
    const missing = $t("zzz-strategy.text_16af525009", { "name": name, "source": author.source });
    return options.operation(`zzz/${name}/numbered/${number}`, update, async () => {
      const filename = `role_guide_${name}.png`;
      const local = join("numbered", "ZenlessZoneZero", author.source, filename);
      const bytes = await options.readCollectionImage(local, update,
        () => options.collections.image({ name }, author, update, "zzz"), async () => {
          const path = join("images", "guides", author.source, filename);
          for (const root of [options.legacyResources, options.archivedResources]) {
            if (!root) continue;
            const bytes = await readGuideImage(root, path);
            if (bytes) return bytes;
          }
        });
      return bytes ? { type: "image", file: bytes } : missing;
    }, missing);
  }

  async function lookup(query: string, update: boolean, number?: number): Promise<CommandReply> {
    const name = await canonicalName(query);
    if (number) return one(name, number, update);
    const config = await settings();
    const selected = number ?? config.default_guide;
    if (selected !== 0) return one(name, selected, update);
    const nodes = await Promise.all(sources.slice(0, config.max_forward_guides).map((_, index) => one(name, index + 1, update)));
    return { type: "forward", nodes };
  }

  return {
    lookup,
    command(input: string, isMaster: boolean): CommandReply | Promise<CommandReply> | undefined {
      const found = prefix.exec(input);
      if (!found) return;
      const command = input.slice(found[0].length);
      if (/^攻略(?:说明|帮助)$/u.test(command)) return help;
      const choice = /^(?:设置默认攻略(\d+|all)|设置所有攻略显示个数(\d+))$/iu.exec(command);
      if (choice) {
        if (!isMaster) return $t("zzz-strategy.text_20005a38e7");
        const [defaultSource, maximum] = [choice[1], choice[2]];
        const selected = defaultSource?.toLowerCase() === "all" ? 0 : Number(defaultSource ?? maximum);
        if (!validInteger(selected, maximum === undefined ? 0 : 1)) {
          return maximum === undefined ? $t("zzz-strategy.text_f1ade3a6a7") : $t("zzz-strategy.text_64f2ef0e1b");
        }
        const key = maximum === undefined ? "default_guide" : "max_forward_guides";
        return set(key, selected).then(() => maximum === undefined
          ? $t("zzz-strategy.text_3accd00fae", { "value1": selected ? ` ${selected}（${sources[selected - 1]!.source}）` : $t("zzz-strategy.text_62c74e680e") })
          : $t("zzz-strategy.text_ddd4370c0d", { "selected": selected }), () => $t("zzz-strategy.text_2484f5af4d"));
      }
      const match = /^(更新|刷新)?(\S+?)攻略(\d+|all)?$/iu.exec(command);
      if (!match || (!match[3] && match[1] !== "刷新") || !safeGuideName(match[2]!)) return;
      const number = match[3] === undefined ? undefined : match[3].toLowerCase() === "all" ? 0 : Number(match[3]);
      if (number !== undefined && !validInteger(number, 0)) return $t("zzz-strategy.text_e995d5a8a5");
      return lookup(match[2]!, !!match[1], number);
    },
  };
}
