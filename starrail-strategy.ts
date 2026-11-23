import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandReply } from "../../lib/commands.ts";
import { lockFile } from "../../lib/file-lock.ts";
import { readMigrationSourceFile } from "../../lib/migration-files.ts";
import type { createRoleGuideCache } from "./role-guide-cache.ts";
import type { createRoleGuideCollections } from "./role-guide-collections.ts";
import { safeGuideName, type GuideRole } from "./role-guide-input.ts";
import { isGuideImage, readGuideFile, roleImageLimit, writeGuideFile } from "./role-image-files.ts";

// The independent plugin at 308a83d uses a different numbered list from the configurable author collections.
const sources = [
  { source: "初始镜像", collection_id: [1996095] },
  { source: "小橙子阿", collection_id: [1998643] },
  { source: "星穹中心", collection_id: [2029394, 2009142, 2038092] },
] as const;
const numbers = [1, 2, 3] as const;

export const starRailStrategyHelp = [
  "星铁编号攻略",
  "*希儿攻略2 或 *更新希儿攻略2 可查询或刷新指定作者的原图。",
  "*希儿攻略0 和 *希儿攻略all 均查询三个旧编号来源。图文版本以原作者发布为准。",
  "机器人主人可用 *设置默认攻略0 至 *设置默认攻略3 切换默认来源。",
  ...sources.map(({ source }, index) => `${index + 1}. ${source}`),
  "了解角色一图流及其他命令 https://www.lotusshared.cn/yunzai/",
].join("\n");

const settingFile = "starrail-strategy.json";
const ownSource = (value: unknown): value is number => value === 0 || value === 1 || value === 2 || value === 3;
const trailblazerPaths = new Map([
  ["物主", "开拓者·毁灭"], ["火主", "开拓者·存护"], ["虚数主", "开拓者·同谐"],
  ["冰主", "开拓者·记忆"], ["雷主", "开拓者·欢愉"],
]);

function preference(data: unknown, legacy = false) {
  if (!data || typeof data !== "object" || !("defaultSource" in data)) return;
  const raw = data.defaultSource;
  const value = legacy && typeof raw === "string" ? (raw === "all" ? 0 : /^[0-3]$/u.test(raw) ? Number(raw) : undefined) : raw;
  if (ownSource(value)) return value;
}

export function createStarRailStrategy(options: {
  readonly cache: string;
  readonly settingsRoot?: URL;
  readonly forward?: boolean;
  readonly signal?: AbortSignal;
  readonly collections: Pick<ReturnType<typeof createRoleGuideCollections>, "image">;
  readonly readCollectionImage: ReturnType<typeof createRoleGuideCache>;
}) {
  const { cache, settingsRoot, signal } = options;
  const installation = settingsRoot && fileURLToPath(settingsRoot);
  const oldLocations = installation ? ["plugins", "backup/plugins"].map(location => join(installation, location, "StarRail-plugin")) : [];

  async function defaultSource() {
    try {
      const file = await readGuideFile(cache, settingFile, 64 * 1024);
      if (file) return preference(JSON.parse(file.toString("utf8")));
    } catch {}
    if (!installation) return;
    for (const base of oldLocations) {
      try {
        const file = await readMigrationSourceFile(installation, join(base, "config/mys.yaml"), 64 * 1024, signal);
        if (file) {
          const value = preference(Bun.YAML.parse(file.bytes.toString("utf8")), true);
          if (value !== undefined) return value;
        }
      } catch {}
    }
  }

  async function set(source: number, canManage: () => boolean) {
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const lock = await lockFile(join(cache, ".starrail-strategy.sqlite"), "星铁攻略设置");
    try {
      if (!await writeGuideFile(join(cache, settingFile), JSON.stringify({ defaultSource: source }) + "\n",
        () => !signal?.aborted && canManage())) throw Error("攻略设置会话已结束。");
    } finally { lock.close(); }
    return `已设置星铁默认攻略${source === 0 ? "为全部旧编号来源" : `来源 ${source}（${sources[source - 1]!.source}）`}。`;
  }

  async function oldImage(source: number, filename: string) {
    if (!installation) return;
    for (const base of oldLocations) {
      try {
        const file = await readMigrationSourceFile(installation, join(base, "temp/strategy", String(source), filename), roleImageLimit, signal);
        if (file && isGuideImage(file.bytes)) return file.bytes;
      } catch {}
    }
  }

  async function lookup(role: GuideRole, source: number, update: boolean): Promise<CommandReply | undefined> {
    if (!ownSource(source)) return "星铁攻略编号须为 0 至 3。请发送 *攻略帮助 查看来源。";
    const displayName = role.name;
    const name = trailblazerPaths.get(displayName) ?? displayName.replace(/^托帕[&＆]账账$/u, "托帕").replaceAll("•", "·");
    if (!safeGuideName(name)) return;
    const filename = name + ".jpg";
    const selected = source === 0 ? numbers : [source];
    const found = await Promise.all(selected.map(async number => {
      const author = sources[number - 1]!;
      const cached = join("starrail-numbered", String(number), filename);
      const alternate = displayName !== name && safeGuideName(displayName) ? displayName + ".jpg" : undefined;
      const bytes = await options.readCollectionImage(cached, update,
        () => options.collections.image({ ...role, name }, author, update, "sr"),
        async () => await oldImage(number, filename) ?? (alternate ? await oldImage(number, alternate) : undefined));
      return { author, number, bytes };
    }));
    const nodes = found.flatMap(({ author, number, bytes }) => bytes ? [
      [`旧编号 ${number} · ${author.source} · ${displayName}攻略`, { type: "image" as const, file: bytes }],
    ] : []);
    if (!nodes.length) return `暂无${displayName}攻略（${source === 0 ? "旧编号来源" : sources[source - 1]!.source}）。请发送 *攻略帮助 查看来源。`;
    const missing = found.filter(result => !result.bytes).map(result => result.author.source);
    if (missing.length) nodes.push([`暂无${missing.join("、")}的原图。`]);
    if (nodes.length === 1) return nodes[0]!;
    return options.forward === false ? nodes.flat() : { type: "forward", senderName: `${displayName}旧编号攻略`, nodes };
  }

  function command(message: string, canManage: () => boolean): CommandReply | Promise<CommandReply> | undefined {
    if (/^#?星铁攻略(?:帮助|说明)$/u.test(message)) return starRailStrategyHelp;
    const selected = /^(?:#?星铁设置默认攻略(\d+|all)?|#设置默认攻略(0))$/iu.exec(message);
    if (!selected) return;
    if (!canManage() || signal?.aborted) return "只有主人可以设置星铁默认攻略。";
    const input = selected[1] ?? selected[2];
    const value = input?.toLowerCase() === "all" ? 0 : Number(input);
    if (!ownSource(value)) return "请发送 *设置默认攻略0 至 *设置默认攻略3，0 表示全部旧编号来源。";
    return set(value, canManage).catch(() => "保存星铁默认攻略失败，请稍后再试。");
  }

  return { command, defaultSource, lookup };
}
