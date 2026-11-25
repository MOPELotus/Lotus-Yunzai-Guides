import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandReply } from "../../lib/commands.ts";
import { lockFile } from "../../lib/file-lock.ts";
import { readMigrationSourceFile } from "../../lib/migration-files.ts";
import { GuideSettingsError } from "./guide-configuration.ts";
import type { createRoleGuideCache } from "./role-guide-cache.ts";
import type { createRoleGuideCollections } from "./role-guide-collections.ts";
import { safeGuideName, type GuideRole } from "./role-guide-input.ts";
import { isGuideImage, readGuideFile, roleImageLimit, writeGuideFile } from "./role-image-files.ts";

// The independent plugin at 308a83d uses a different numbered list from the configurable author collections.
const sources = [
  { source: $t("starrail-strategy.text_0d3bc5965f"), collection_id: [1996095] },
  { source: $t("starrail-strategy.text_8176f01698"), collection_id: [1998643] },
  { source: $t("starrail-strategy.text_21c2c12838"), collection_id: [2029394, 2009142, 2038092] },
] as const;
const numbers = [1, 2, 3] as const;

export const starRailStrategyHelp = [
  $t("starrail-strategy.text_33f46d3479"),
  $t("starrail-strategy.text_3702fbbed2"),
  $t("starrail-strategy.text_1c3982a08a"),
  $t("starrail-strategy.text_ab047ac488"),
  ...sources.map(({ source }, index) => `${index + 1}. ${source}`),
  $t("starrail-strategy.text_3c35fa62e2"),
].join("\n");

const settingFile = "starrail-strategy.json";
const ownSource = (value: unknown): value is 0 | 1 | 2 | 3 => value === 0 || value === 1 || value === 2 || value === 3;
const trailblazerPaths = new Map([
  ["物主", $t("starrail-strategy.text_9680e7c3f3")], ["火主", $t("starrail-strategy.text_877e966392")], ["虚数主", $t("starrail-strategy.text_38d72b38b9")],
  ["冰主", $t("starrail-strategy.text_8c62b9ec0e")], ["雷主", $t("starrail-strategy.text_474aeb4317")],
]);

function preference(data: unknown, legacy = false) {
  if (!data || typeof data !== "object" || !("defaultSource" in data)) return;
  const raw = data.defaultSource;
  const value = legacy && typeof raw === "string" ? (raw === "all" ? 0 : /^[0-3]$/u.test(raw) ? Number(raw) : undefined) : raw;
  if (ownSource(value)) return value;
}

export const starRailStrategyOptions = [
  { label: $t("starrail-strategy.text_f58cf6cec8"), value: "current" },
  { label: $t("starrail-strategy.text_79ee0edc7e"), value: 0 },
  ...numbers.map(value => ({ label: `${value} · ${sources[value - 1]!.source}`, value })),
] as const;
type StrategyChoice = (typeof starRailStrategyOptions)[number]["value"];

export function validStarRailStrategyChoice(value: unknown): value is StrategyChoice {
  return value === "current" || ownSource(value);
}

function legacyRoots(installation: string | undefined) {
  return installation ? ["plugins", "backup/plugins"].map(location => join(installation, location, "StarRail-plugin")) : [];
}

export function createStarRailStrategyPreference({ cache, settingsRoot, signal }: {
  readonly cache: string;
  readonly settingsRoot?: URL;
  readonly signal?: AbortSignal;
}) {
  const installation = settingsRoot && fileURLToPath(settingsRoot);

  async function get(): Promise<StrategyChoice> {
    try {
      const file = await readGuideFile(cache, settingFile, 64 * 1024);
      if (file) return preference(JSON.parse(file.toString("utf8"))) ?? "current";
    } catch {}
    if (installation) {
      for (const base of legacyRoots(installation)) {
        try {
          const file = await readMigrationSourceFile(installation, join(base, "config/mys.yaml"), 64 * 1024, signal);
          if (file) {
            const value = preference(Bun.YAML.parse(file.bytes.toString("utf8")), true);
            if (value !== undefined) return value;
          }
        } catch {}
      }
    }
    return "current";
  }

  async function set(source: StrategyChoice, { previous, canWrite }: {
    readonly previous?: StrategyChoice;
    readonly canWrite?: () => boolean;
  } = {}) {
    const active = () => !signal?.aborted && (!canWrite || canWrite());
    if (!validStarRailStrategyChoice(source)) throw new GuideSettingsError("input");
    if (!active()) throw new GuideSettingsError("permission");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const lock = await lockFile(join(cache, ".starrail-strategy.sqlite"), $t("starrail-strategy.text_2fa06444ff"));
    try {
      const current = await get();
      if (previous !== undefined && current !== previous) throw new GuideSettingsError("conflict");
      if (!active()) throw new GuideSettingsError("permission");
      if ((previous === undefined || current !== source) && !await writeGuideFile(join(cache, settingFile),
        JSON.stringify({ defaultSource: source === "current" ? null : source }) + "\n", active)) {
        throw new GuideSettingsError("permission");
      }
      return source;
    } finally { lock.close(); }
  }

  return { get, set };
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
  const oldLocations = legacyRoots(installation);
  const strategy = createStarRailStrategyPreference(options);

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
    if (!ownSource(source)) return $t("starrail-strategy.text_a00f8bd07b");
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
      [$t("starrail-strategy.text_88721e6ca7", { "number": number, "source": author.source, "displayName": displayName }), { type: "image" as const, file: bytes }],
    ] : []);
    if (!nodes.length) return $t("starrail-strategy.text_91855e03f8", { "displayName": displayName, "value2": source === 0 ? $t("starrail-strategy.text_aacffbe8c8") : sources[source - 1]!.source });
    const missing = found.filter(result => !result.bytes).map(result => result.author.source);
    if (missing.length) nodes.push([$t("starrail-strategy.text_7a393835c0", { "value1": missing.join("、") })]);
    if (nodes.length === 1) return nodes[0]!;
    return options.forward === false ? nodes.flat() : { type: "forward", senderName: $t("starrail-strategy.text_78cc00bb61", { "displayName": displayName }), nodes };
  }

  function command(message: string, canManage: () => boolean): CommandReply | Promise<CommandReply> | undefined {
    if (/^#?星铁攻略(?:帮助|说明)$/u.test(message)) return starRailStrategyHelp;
    const selected = /^(?:#?星铁设置默认攻略(\d+|all)?|#设置默认攻略(0))$/iu.exec(message);
    if (!selected) return;
    if (!canManage() || signal?.aborted) return $t("starrail-strategy.text_082c97e645");
    const input = selected[1] ?? selected[2];
    const value = input?.toLowerCase() === "all" ? 0 : Number(input);
    if (!ownSource(value)) return $t("starrail-strategy.text_eba6074f12");
    return strategy.set(value, { canWrite: canManage }).then(() =>
      $t("starrail-strategy.text_454d08bcaf", { "value1": value === 0 ? $t("starrail-strategy.text_14335c16a9") : $t("starrail-strategy.text_19a4b2724d", { "value": value, "source": sources[value - 1]!.source }) }),
      () => $t("starrail-strategy.text_d07b0469e6"));
  }

  return {
    command,
    async defaultSource() {
      const source = await strategy.get();
      return source === "current" ? undefined : source;
    },
    lookup,
  };
}
