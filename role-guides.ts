// Source precedence and legacy cache layout are from Mora-Plugin model/roleGuide.js.
import { join } from "node:path";
import type { CommandReply } from "../../lib/commands.ts";
import { createRoleGuideCollections } from "./role-guide-collections.ts";
import { createRoleResourcePack, type RolePackFallback, type RolePackSnapshot } from "./role-resource-pack.ts";
import { guideGames, parseGuideCommand, resolveGuideRole, safeGuideName, type GuideGame } from "./role-guide-input.ts";
import { findGuidePack, readGuideImage, writeGuideFile, type GuideImage } from "./role-image-files.ts";

export function createRoleGuides(options: {
  readonly cache: string;
  readonly legacyStrategies?: readonly string[];
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

  async function lookup(game: GuideGame, role: Exclude<ReturnType<typeof resolveGuideRole>, string | undefined>, update: boolean): Promise<CommandReply> {
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
        for (const directory of options.legacyStrategies ?? []) {
          saved = await readGuideImage(directory, join(String(legacyIndex), filename));
          if (saved) break;
        }
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
    if (!result.length) return `暂无${role.name}的${gamePath.label}攻略。`;
    if (result.length === 1) return result[0]!;
    const title = role.name + "攻略~";
    return options.forward === false ? [title, ...result] : { type: "forward", nodes: [title, ...result] };
  }

  return (message: string): CommandReply | Promise<CommandReply> | undefined => {
    const command = parseGuideCommand(message);
    if (!command) return;
    const role = resolveGuideRole(command.role, command.game);
    if (!role || typeof role === "string") return role;
    if (!safeGuideName(role.name)) return;
    const roleKey = `${command.game}/${role.name}`;
    const refreshKey = `${roleKey}/true`;
    const key = command.update ? refreshKey : `${roleKey}/false`;
    let operation = pending.get(refreshKey) ?? pending.get(key);
    if (!operation) {
      const inFlight = command.update ? pending.get(`${roleKey}/false`) : undefined;
      operation = Promise.resolve(inFlight).then(() => lookup(command.game, role, command.update)).catch(() =>
        `暂时无法取得${role.name}的${guideGames[command.game].label}攻略。`).finally(() => pending.delete(key));
      pending.set(key, operation);
    }
    return operation;
  };
}
