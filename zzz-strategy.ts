import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CommandReply } from "../../lib/commands.ts";
import type { MessageSegment } from "../../lib/messages.ts";
import { lockFile } from "../../lib/file-lock.ts";
import type { createRoleGuideCollections } from "./role-guide-collections.ts";
import { guideKey, safeGuideName } from "./role-guide-input.ts";
import { readGuideFile, readGuideImage, writeGuideFile } from "./role-image-files.ts";

// ZZZ-Plugin dist/lib/guides.js, 2057599. Public MiYouShe ZZZ collections in source-number order.
const sources = [
  { source: "新艾利都快讯", collection_id: [2712859] },
  { source: "清茶沐沐Kiyotya", collection_id: [2727116] },
  { source: "小橙子阿", collection_id: [2721968] },
  { source: "猫冬", collection_id: [2724610] },
  { source: "月光中心", collection_id: [2722266] },
  { source: "苦雪的清心花凉糕Suki", collection_id: [2723586] },
  { source: "HoYo青枫", collection_id: [2716049] },
] as const;

const help = [
  "绝区零编号攻略",
  "用 %艾莲攻略2 选择来源，用 %艾莲攻略all 查看多个来源。要重新取图，可发送 %更新艾莲攻略2。",
  "主人可用 %设置默认攻略2 或 %设置默认攻略all，以及 %设置所有攻略显示个数4。",
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

export function createZzzStrategy(options: {
  readonly cache: string;
  readonly legacyResources?: string;
  readonly legacyRoot?: string;
  readonly collections: ReturnType<typeof createRoleGuideCollections>;
  operation(key: string, update: boolean, load: () => Promise<GuideReply>, error: string): Promise<GuideReply>;
}) {
  async function settings(): Promise<Settings> {
    const [defaults, legacy, current] = await Promise.all([
      object(options.legacyRoot, "defSet/guide.yaml", Bun.YAML.parse),
      object(options.legacyRoot, "config/guide.yaml", Bun.YAML.parse),
      object(options.cache, settingsFile, JSON.parse),
    ]);
    return { ...settingsDefaults, ...configValues(defaults), ...configValues(legacy), ...configValues(current) };
  }

  async function set(key: keyof Settings, value: number) {
    await mkdir(options.cache, { recursive: true, mode: 0o700 });
    const lock = await lockFile(join(options.cache, ".zzz-strategy.sqlite"), "绝区零攻略设置");
    try {
      const current = configValues(await object(options.cache, settingsFile, JSON.parse));
      await writeGuideFile(join(options.cache, settingsFile), JSON.stringify({ ...current, [key]: value }) + "\n");
    } finally {
      lock.close();
    }
  }

  async function canonicalName(query: string) {
    const key = guideKey(query);
    for (const file of ["config/alias.yaml", "defSet/alias.yaml"]) {
      const aliases = await object(options.legacyRoot, file, Bun.YAML.parse);
      for (const [name, names] of Object.entries(aliases)) {
        if (safeGuideName(name) && (guideKey(name) === key || Array.isArray(names) &&
          names.some((alias) => typeof alias === "string" && guideKey(alias) === key))) return name;
      }
    }
    return query;
  }

  function one(name: string, number: number, update: boolean): Promise<GuideReply> {
    const author = sources[number - 1]!;
    const missing = `暂无${name}攻略（${author.source}）。`;
    return options.operation(`zzz/${name}/numbered/${number}`, update, async () => {
      const filename = `role_guide_${name}.png`;
      const local = join("numbered", "ZenlessZoneZero", author.source, filename);
      let bytes = await readGuideImage(options.cache, local);
      if (!bytes && options.legacyResources) {
        bytes = await readGuideImage(options.legacyResources, join("images", "guides", author.source, filename));
      }
      if (!bytes || update) {
        const downloaded = await options.collections.image({ name }, author, update, "zzz");
        if (downloaded) {
          await writeGuideFile(join(options.cache, local), downloaded).catch(() => {});
          bytes = downloaded;
        }
      }
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
        if (!isMaster) return "只有主人可以设置绝区零攻略来源。";
        const [defaultSource, maximum] = [choice[1], choice[2]];
        const selected = defaultSource?.toLowerCase() === "all" ? 0 : Number(defaultSource ?? maximum);
        if (!validInteger(selected, maximum === undefined ? 0 : 1)) {
          return maximum === undefined ? "请选择攻略编号 0–7 或 all。" : "所有攻略显示个数须为 1–7。";
        }
        const key = maximum === undefined ? "default_guide" : "max_forward_guides";
        return set(key, selected).then(() => maximum === undefined
          ? `已设置绝区零默认攻略来源${selected ? ` ${selected}（${sources[selected - 1]!.source}）` : "为全部"}。`
          : `已设置绝区零所有攻略显示个数为 ${selected}。`, () => "保存绝区零攻略设置失败，请稍后再试。");
      }
      const match = /^(更新|刷新)?(\S+?)攻略(\d+|all)?$/iu.exec(command);
      if (!match || (!match[3] && match[1] !== "刷新") || !safeGuideName(match[2]!)) return;
      const number = match[3] === undefined ? undefined : match[3].toLowerCase() === "all" ? 0 : Number(match[3]);
      if (number !== undefined && !validInteger(number, 0)) return "攻略编号超出范围。请发送 %攻略帮助 查看来源。";
      return lookup(match[2]!, !!match[1], number);
    },
  };
}
