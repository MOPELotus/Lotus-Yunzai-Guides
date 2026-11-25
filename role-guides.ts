import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
// Source precedence and legacy cache layout are from Mora-Plugin model/roleGuide.js.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { characterAliasKey, readGameCharacterAliases } from "../../lib/game-character-aliases.ts";
import type { CommandReply } from "../../lib/commands.ts";
import { createGenshinStrategyPreference, genshinStrategyHelp, genshinStrategyNumber, genshinStrategySource } from "./genshin-strategy.ts";
import { createRoleGuideCollections } from "./role-guide-collections.ts";
import { createRoleGuideCache } from "./role-guide-cache.ts";
import { createRoleResourcePack, type RolePackFallback, type RolePackSnapshot } from "./role-resource-pack.ts";
import { guideGames, normalizeStarRailGuideCommand, parseGuideCommand, resolveGuideRole, safeGuideName, type GuideGame, type GuideRole } from "./role-guide-input.ts";
import { findGuidePack, readGuideImage, type GuideImage } from "./role-image-files.ts";
import { createStarRailGuideHistory } from "./starrail-guide-history.ts";
import { createStarRailStrategy } from "./starrail-strategy.ts";
import { createZzzStrategy } from "./zzz-strategy.ts";

export function createRoleGuides(options: {
  readonly cache: string;
  readonly legacyStrategies?: readonly string[];
  readonly legacyAddOns?: string;
  readonly legacyStrategySettings?: string;
  readonly legacyZzzResources?: string;
  readonly legacyZzzRoot?: string;
  readonly archivedZzzResources?: string;
  readonly atlas?: string;
  readonly config?: string;
  readonly settingsRoot?: URL;
  readonly guidePack?: RolePackFallback;
  readonly guideSnapshot?: RolePackSnapshot;
  readonly guideAutomatic?: boolean;
  readonly signal?: AbortSignal;
  readonly forward?: boolean;
  readonly fetch?: typeof fetch;
  readonly guideSource?: string;
  readonly now?: () => number;
}) {
  const collections = createRoleGuideCollections(options);
  const readCollectionImage = createRoleGuideCache({
    cache: options.cache, automatic: options.guideAutomatic, signal: options.signal, now: options.now,
  });
  const rolePack = createRoleResourcePack({
    root: join(options.cache, "mora"), fallback: options.guidePack, snapshot: options.guideSnapshot,
    automatic: options.guideAutomatic,
    upstream: options.guideSource, signal: options.signal,
  });
  const pending = new Map<string, Promise<CommandReply>>();
  const preference = createGenshinStrategyPreference(join(options.cache, "genshin-strategy.json"), options.legacyStrategySettings);

  function operation<Reply extends CommandReply>(roleKey: string, update: boolean, load: () => Promise<Reply>, error: string) {
    const refreshKey = `${roleKey}/refresh`;
    const readKey = `${roleKey}/read`;
    const key = update ? refreshKey : readKey;
    let result = pending.get(refreshKey) ?? pending.get(key);
    if (!result) {
      const inFlight = update ? pending.get(readKey) : undefined;
      result = Promise.resolve(inFlight).then(load).catch(() => error).finally(() => pending.delete(key));
      pending.set(key, result);
    }
    return result as Promise<Reply | string>;
  }

  const starRail = createStarRailStrategy({ ...options, collections, readCollectionImage });
  const starRailHistory = createStarRailGuideHistory(options);
  const zzz = createZzzStrategy({ cache: options.cache, legacyRoot: options.legacyZzzRoot,
    legacyResources: options.legacyZzzResources, archivedResources: options.archivedZzzResources,
    archivedRoot: options.archivedZzzResources ? dirname(options.archivedZzzResources) : undefined,
    collections, readCollectionImage, operation });

  async function legacyImage(source: number, filename: string) {
    for (const directory of options.legacyStrategies ?? []) {
      const bytes = await readGuideImage(directory, join(String(source), filename));
      if (bytes) return bytes;
    }
  }

  function numberedLookup(role: GuideRole, source: number, update: boolean): Promise<CommandReply> {
    const author = genshinStrategySource(source);
    if (!author) return Promise.resolve($t("role-guides.text_ef000bdafe"));
    const error = $t("role-guides.text_58b8b6d917", { "name": role.name, "source": author.source });
    return operation(`gs/${role.name}/numbered/${source}`, update, async () => {
      const filename = role.name + ".jpg";
      const local = join("numbered", String(source), filename);
      const bytes = await readCollectionImage(local, update,
        () => collections.image(role, author, update, "gs"), () => legacyImage(source, filename));
      return bytes ? { type: "image", file: bytes } : error;
    }, error);
  }

  async function fromAtlas(game: GuideGame, name: string, id?: string): Promise<GuideImage | undefined> {
    if (!options.atlas || game === "gs") return;
    if (game === "sr") {
      const directory = join(options.atlas, "star-rail-atlas", "guide for role");
      const byId = id && safeGuideName(id) ? await readGuideImage(directory, id + ".png") : undefined;
      const bytes = byId ?? await readGuideImage(directory, name + ".png");
      if (bytes) return { source: $t("role-guides.text_924f484f0d"), bytes };
    } else {
      const bytes = await readGuideImage(join(options.atlas, "zzz-atlas", "角色攻略"), name + ".png");
      if (bytes) return { source: $t("role-guides.text_1acdcd6272"), bytes };
    }
  }

  async function lookup(game: GuideGame, role: GuideRole, update: boolean, useDefault: boolean): Promise<CommandReply> {
    const gamePath = guideGames[game];
    const suffix = game === "gs" ? "" : gamePath.pack;
    async function overrides(root: string | undefined) {
      const [old, renamed] = await Promise.all([
        findGuidePack(root, role.name, suffix), findGuidePack(root, role.name, game),
      ]);
      return [...new Map([...old, ...renamed].map(image => [image.source, image])).values()];
    }
    const [configured, assets, local, archived, atlas] = await Promise.all([
      collections.authors(game), rolePack(game, role.name, update),
      overrides(join(options.cache, "add_ons")), overrides(options.legacyAddOns),
      fromAtlas(game, role.name, role.id),
    ]);
    const overrideMap = new Map([...archived, ...local].map((image) => [image.source, image]));
    const packedNames = new Set(assets.map((image) => image.source));
    const images: GuideImage[] = assets.map((image) => overrideMap.get(image.source) ?? image);
    if (atlas && !packedNames.has(atlas.source)) images.push(overrideMap.get(atlas.source) ?? atlas);

    const fromCollections = await Promise.all([...configured.news, ...configured.olds].map(async (author) => {
      const override = overrideMap.get(author.source);
      if (override) return override;
      // A bundled guide wins for its publisher. Legacy Atlas replaces the matching collection.
      if (packedNames.has(author.source) || atlas?.source === author.source) return;
      const filename = role.name + ".jpg";
      const local = join(author.source, suffix, filename);
      const bytes = await readCollectionImage(local, update, () => collections.image(role, author, update), async () => {
        const renamed = await readGuideImage(options.cache, join(author.source, game, filename));
        if (renamed) return renamed;
        if (game !== "gs") return;
        const number = genshinStrategyNumber(author);
        if (number !== undefined) return legacyImage(number, filename);
      });
      if (bytes) return { source: author.source, bytes };
    }));
    for (const image of fromCollections) if (image) images.push(image);
    images.push(...overrideMap.values());
    const reply = new Map<string, { type: "image"; file: Buffer }>();
    for (const { source, bytes } of images) {
      if (!reply.has(source)) reply.set(source, { type: "image", file: bytes });
    }
    const result = [...reply.values()];
    if (!result.length) {
      if (useDefault && game === "gs") return numberedLookup(role, await preference.get(), update);
      if (useDefault && game === "zzz") return zzz.lookup(role.name, update);
      return $t("role-guides.text_b783a829fe", { "name": role.name, "label": gamePath.label });
    }
    if (result.length === 1) return result[0]!;
    const title = role.name + $t("role-guides.text_d2f920b643");
    return options.forward === false ? [title, ...result] : { type: "forward", nodes: [title, ...result] };
  }

  return (message: string, isMaster = false, canManage = () => isMaster): CommandReply | Promise<CommandReply | undefined> | undefined => {
    const input = normalizeStarRailGuideCommand(message);
    const zzzCommand = zzz.command(input, isMaster);
    if (zzzCommand !== undefined) return zzzCommand;
    const starRailCommand = starRail.command(input, canManage) ?? starRailHistory(input);
    if (starRailCommand !== undefined) return starRailCommand;
    if (/^#?(?:原神)?攻略(?:帮助|说明)?$/u.test(input)) return genshinStrategyHelp;
    const setting = /^#?(?:原神)?设置默认攻略([1-7])?$/u.exec(input);
    if (setting) {
      if (!isMaster) return $t("role-guides.text_2e8f813ad5");
      if (!setting[1]) return $t("role-guides.text_359a3bde90");
      const source = Number(setting[1]);
      return preference.set(source).then(() => $t("role-guides.text_353dfeb909", { "source": source, "value2": genshinStrategySource(source)!.source }),
        () => $t("role-guides.text_254303838f"));
    }
    const command = parseGuideCommand(input);
    if (!command) return;
    const { game, source, update } = command;
    function answer(role: ReturnType<typeof resolveGuideRole>): CommandReply | Promise<CommandReply | undefined> | undefined {
      if (!role) return;
      if (typeof role === "string") {
        return source === undefined ? role : role.replace(/((?:虚数|[风岩雷草水火冰物])主攻略)(?=、|$)/gu, `$1${source}`);
      }
      if (!safeGuideName(role.name)) return;
      if (source !== undefined) return game === "sr" ? starRail.lookup(role, source, update) : numberedLookup(role, source, update);
      const withPreference = input.endsWith("攻略");
      const fallbackPreference = game !== "sr" && withPreference;
      const standard = () => operation(`${game}/${role.name}/${fallbackPreference ? "strategy" : "guide"}`, update,
        () => lookup(game, role, update, fallbackPreference),
        $t("role-guides.text_8b7f0ff356", { "name": role.name, "label": guideGames[game].label }));
      return game === "sr" && withPreference ? starRail.defaultSource().then(preferred =>
        preferred === undefined ? standard() : starRail.lookup(role, preferred, update)) : standard();
    }
    const role = resolveGuideRole(command.role, game);
    if (role || game !== "sr" || !options.settingsRoot) return answer(role);
    return readGameCharacterAliases("sr", fileURLToPath(options.settingsRoot)).then(aliases => {
      const canonical = aliases.get(characterAliasKey(command.role));
      return answer(canonical ? resolveGuideRole(canonical, game) : undefined);
    });
  };
}
