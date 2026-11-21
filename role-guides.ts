// Source precedence and legacy cache layout are from Mora-Plugin model/roleGuide.js.
import { join } from "node:path";
import type { CommandReply } from "../../lib/commands.ts";
import { createGenshinStrategyPreference, genshinStrategyHelp, genshinStrategySource } from "./genshin-strategy.ts";
import { createRoleGuideCollections } from "./role-guide-collections.ts";
import { createRoleResourcePack, type RolePackFallback, type RolePackSnapshot } from "./role-resource-pack.ts";
import { guideGames, parseGuideCommand, resolveGuideRole, safeGuideName, type GuideGame, type GuideRole } from "./role-guide-input.ts";
import { findGuidePack, readGuideImage, writeGuideFile, type GuideImage } from "./role-image-files.ts";

export function createRoleGuides(options: {
  readonly cache: string;
  readonly legacyStrategies?: readonly string[];
  readonly legacyStrategySettings?: string;
  readonly atlas?: string;
  readonly config?: string;
  readonly guidePack?: RolePackFallback;
  readonly guideSnapshot?: RolePackSnapshot;
  readonly guideAutomatic?: boolean;
  readonly signal?: AbortSignal;
  readonly forward?: boolean;
  readonly fetch?: typeof fetch;
  readonly guideSource?: string;
}) {
  const collections = createRoleGuideCollections(options);
  const rolePack = createRoleResourcePack({
    root: join(options.cache, "mora"), fallback: options.guidePack, snapshot: options.guideSnapshot,
    automatic: options.guideAutomatic,
    upstream: options.guideSource, signal: options.signal,
  });
  const pending = new Map<string, Promise<CommandReply>>();
  const preference = createGenshinStrategyPreference(join(options.cache, "genshin-strategy.json"), options.legacyStrategySettings);

  function operation(roleKey: string, update: boolean, load: () => Promise<CommandReply>, error: string) {
    const refreshKey = `${roleKey}/refresh`;
    const readKey = `${roleKey}/read`;
    const key = update ? refreshKey : readKey;
    let result = pending.get(refreshKey) ?? pending.get(key);
    if (!result) {
      const inFlight = update ? pending.get(readKey) : undefined;
      result = Promise.resolve(inFlight).then(load).catch(() => error).finally(() => pending.delete(key));
      pending.set(key, result);
    }
    return result;
  }

  async function legacyImage(source: number, filename: string) {
    for (const directory of options.legacyStrategies ?? []) {
      const bytes = await readGuideImage(directory, join(String(source), filename));
      if (bytes) return bytes;
    }
  }

  function numberedLookup(role: GuideRole, source: number, update: boolean): Promise<CommandReply> {
    const author = genshinStrategySource(source);
    if (!author) return Promise.resolve("原神攻略来源编号无效。请发送 #攻略帮助 查看来源。");
    const error = `暂无${role.name}攻略（${author.source}）。可发送 #攻略帮助 查看其他来源。`;
    return operation(`gs/${role.name}/numbered/${source}`, update, async () => {
      const filename = role.name + ".jpg";
      const local = join("numbered", String(source), filename);
      let bytes = await readGuideImage(options.cache, local) ?? await legacyImage(source, filename);
      if (!bytes || update) {
        const downloaded = await collections.image(role, author, update, true);
        if (downloaded) {
          await writeGuideFile(join(options.cache, local), downloaded).catch(() => {});
          bytes = downloaded;
        }
      }
      return bytes ? { type: "image", file: bytes } : error;
    }, error);
  }

  async function fromAtlas(game: GuideGame, name: string, id?: string): Promise<GuideImage | undefined> {
    if (!options.atlas || game === "gs") return;
    if (game === "sr") {
      const directory = join(options.atlas, "star-rail-atlas", "guide for role");
      const byId = id && safeGuideName(id) ? await readGuideImage(directory, id + ".png") : undefined;
      const bytes = byId ?? await readGuideImage(directory, name + ".png");
      if (bytes) return { source: "听语惊花", bytes };
    } else {
      const bytes = await readGuideImage(join(options.atlas, "zzz-atlas", "角色攻略"), name + ".png");
      if (bytes) return { source: "新艾利都快讯", bytes };
    }
  }

  async function lookup(game: GuideGame, role: GuideRole, update: boolean, useDefault: boolean): Promise<CommandReply> {
    const gamePath = guideGames[game];
    const suffix = game === "gs" ? "" : gamePath.pack;
    const [configured, assets, overrides, atlas] = await Promise.all([
      collections.authors(game), rolePack(game, role.name, update),
      findGuidePack(join(options.cache, "add_ons"), role.name, suffix),
      fromAtlas(game, role.name, role.id),
    ]);
    const overrideMap = new Map(overrides.map((image) => [image.source, image]));
    const packedNames = new Set(assets.map((image) => image.source));
    const images: GuideImage[] = assets.map((image) => overrideMap.get(image.source) ?? image);
    if (atlas && !packedNames.has(atlas.source)) images.push(overrideMap.get(atlas.source) ?? atlas);

    const fromCollections = await Promise.all([...configured.news, ...configured.olds].map(async (author, index) => {
      const override = overrideMap.get(author.source);
      if (override) return override;
      // A bundled guide wins for its publisher. Legacy Atlas replaces the matching collection.
      if (packedNames.has(author.source) || atlas?.source === author.source) return;
      const filename = role.name + ".jpg";
      const local = join(author.source, suffix, filename);
      const legacyIndex = index - configured.news.length + 1;
      let saved = await readGuideImage(options.cache, local);
      if (!saved && game === "gs" && legacyIndex > 0) {
        saved = await legacyImage(legacyIndex, filename);
      }
      if (saved && !update) return { source: author.source, bytes: saved };
      const bytes = await collections.image(role, author, update);
      if (bytes) {
        await writeGuideFile(join(options.cache, local), bytes).catch(() => {});
        return { source: author.source, bytes };
      }
      if (saved) return { source: author.source, bytes: saved };
    }));
    for (const image of fromCollections) if (image) images.push(image);
    images.push(...overrides);
    const reply = new Map<string, { type: "image"; file: Buffer }>();
    for (const { source, bytes } of images) {
      if (!reply.has(source)) reply.set(source, { type: "image", file: bytes });
    }
    const result = [...reply.values()];
    if (!result.length) {
      if (useDefault) return numberedLookup(role, await preference.get(), update);
      return `暂无${role.name}的${gamePath.label}攻略。`;
    }
    if (result.length === 1) return result[0]!;
    const title = role.name + "攻略~";
    return options.forward === false ? [title, ...result] : { type: "forward", nodes: [title, ...result] };
  }

  return (message: string, isMaster = false): CommandReply | Promise<CommandReply> | undefined => {
    const input = message.trim();
    if (/^#?(?:原神)?攻略(?:帮助|说明)?$/u.test(input)) return genshinStrategyHelp;
    const setting = /^#?(?:原神)?设置默认攻略([1-7])?$/u.exec(input);
    if (setting) {
      if (!isMaster) return "只有主人可以设置默认攻略。";
      if (!setting[1]) return "请发送 #设置默认攻略1 至 #设置默认攻略7。";
      const source = Number(setting[1]);
      return preference.set(source).then(() => `已设置默认攻略来源 ${source}（${genshinStrategySource(source)!.source}）。`,
        () => "保存默认攻略来源失败，请稍后再试。");
    }
    const command = parseGuideCommand(message);
    if (!command) return;
    const role = resolveGuideRole(command.role, command.game);
    if (!role) return;
    if (typeof role === "string") {
      return command.source ? role.replace(/([风岩雷草水火冰]主攻略)(?=、|$)/gu, `$1${command.source}`) : role;
    }
    if (!safeGuideName(role.name)) return;
    if (command.source) return numberedLookup(role, command.source, command.update);
    const useDefault = command.game === "gs" && input.endsWith("攻略");
    return operation(`${command.game}/${role.name}/${useDefault ? "strategy" : "guide"}`, command.update,
      () => lookup(command.game, role, command.update, useDefault),
      `暂时无法取得${role.name}的${guideGames[command.game].label}攻略。`);
  };
}
