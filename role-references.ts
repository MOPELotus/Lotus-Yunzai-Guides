import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
// Reference panels and yield curves are from Mora-Plugin model/roleGuide.js.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { characterAliasKey, readGameCharacterAliases } from "../../lib/game-character-aliases.ts";
import type { CommandReply } from "../../lib/commands.ts";
import type { MessageReply } from "../../lib/messages.ts";
import { createRoleResourcePack, referenceNotes, type RolePackFallback, type RolePackSnapshot } from "./role-resource-pack.ts";
import { guideKey, normalizeStarRailGuideCommand, resolveGuideRole, safeGuideName, type GuideGame } from "./role-guide-input.ts";

import { createOriginalStarRailGuideReader } from "./starrail-guide-history.ts";

const genshinHelp = [
  $t("role-references.text_5299d26cf1"),
  $t("role-references.text_8e348c1b50"),
];
const starrailHelp = [
  $t("role-references.text_c4646054ea"),
  $t("role-references.text_5ee099fc3e"),
  $t("role-references.text_a3383e5295"),
];

// Exact filenames from the fixed independent plugin, with old aliases absent from the current role index.
const history = [
  ["三月七","三月七.jpg","看板娘,三祁,纠缠之缘,march7th"],
  ["丹恒","丹恒.jpg","单垣,丹垣,丹桁,danheng"],
  ["佩拉","佩拉.jpg","配拉,佩啦,冰砂糖,pela"],
  ["停云","停云.jpg","停运,听云,tingyun"],
  ["克拉拉","克拉拉.jpg","clara"],
  ["刃","刃.jpg","ren,刀刃,忍,任,人,仁"],
  ["姬子","姬子.jpg","himeko"],
  ["娜塔莎","娜塔莎.jpg","那塔莎,那塔沙,娜塔沙,natasha,渡鸦"],
  ["布洛妮娅","布洛妮娅.jpg","布诺妮亚,布诺妮娅,bronya"],
  ["希儿","希儿.jpg","seele"],
  ["希露瓦","希露瓦.jpg","希录瓦,serval"],
  ["火主","开拓者•存护.jpg",""],
  ["物主","开拓者•毁灭.jpg","岩开拓者"],
  ["彦卿","彦卿.jpg","言情,彦情,言卿,燕青,yanqing"],
  ["景元","景元.jpg","jingyuan"],
  ["杰帕德","杰帕德.jpg","gepard"],
  ["桑博","桑博.jpg","sampo"],
  ["瓦尔特","瓦尔特.jpg","welt"],
  ["白露","白露.jpg","龙女,白麓,bailu"],
  ["素裳","素裳.jpg","sushang"],
  ["罗刹","罗刹.jpg","罗差,罗莎,落差,螺子,lc,裸查,luocha"],
  ["艾丝妲","艾丝妲.jpg","爱思达,爱丝妲,爱思妲,爱丝达,艾思达,艾思妲,艾丝达,富婆,asta"],
  ["虎克","虎克.jpg","胡克,hook"],
  ["银狼","银狼.jpg","音浪,银浪,隐狼,淫狼,鸭子,小鸭,yinlang"],
  ["阿兰","阿兰.jpg","alan,阿郎,阿蓝,arlan"],
  ["青雀","青雀.jpg","青却,卿雀,qingque"],
  ["驭空","驭空.jpg","俊空,军空,junk,jk,yukong"],
  ["黑塔","黑塔.jpg","人偶,herta"],
] as const;
const historicalFiles = new Map<string, string>(history.map(([name, file]) => [name, file]));
const historicalAliases = new Map(history.flatMap(([name, , aliases]) =>
  aliases ? aliases.split(",").map(alias => [alias, name] as const) : []));

function readNotes(bytes: Buffer | undefined, name: string) {
  if (!bytes) return;
  try {
    const value = Bun.YAML.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const notes = value as Record<string, unknown>;
    const hint = notes[name];
    const info = (hint && typeof hint === "object" && !Array.isArray(hint) ? hint : {}) as Record<string, unknown>;
    const url = typeof notes.url === "string" && /^https:\/\/www\.miyoushe\.com\/(?:ys|sr)\/article\/\d+$/u.test(notes.url)
      ? notes.url : undefined;
    const arti = typeof info.mainProp === "string" && typeof info.viceProp === "string"
      ? $t("role-references.text_9c1ee39a9e", { "mainProp": info.mainProp, "viceProp": info.viceProp }) : undefined;
    const brief = typeof info.brief === "string" ? $t("role-references.text_414700cbe8", { "brief": info.brief }) : undefined;
    return { url, arti, brief };
  } catch {}
}

export function createRoleReferences(options: {
  readonly cache: string;
  readonly settingsRoot?: URL;
  readonly fetch?: typeof fetch;
  readonly guidePack?: RolePackFallback;
  readonly guideSnapshot?: RolePackSnapshot;
  readonly guideAutomatic?: boolean;
  readonly signal?: AbortSignal;
  readonly forward?: boolean;
  readonly guideSource?: string;
}) {
  const pack = createRoleResourcePack({
    root: join(options.cache, "mora-reference"), references: true, fallback: options.guidePack, snapshot: options.guideSnapshot,
    automatic: options.guideAutomatic,
    upstream: options.guideSource, signal: options.signal,
  });

  const original = createOriginalStarRailGuideReader(options);

  async function historicalReference(name?: string): Promise<CommandReply | undefined> {
    const file = name === undefined ? "help.jpg" : historicalFiles.get(name);
    if (!file) return;
    const bytes = await original(file);
    if (options.signal?.aborted) return;
    if (bytes) return [$t("role-references.text_7cc599b706", { "value1": name === undefined ? $t("role-references.text_d93a766b5f") : $t("role-references.text_c93d0b7917", { "name": name }) }), { type: "image", file: bytes }];
  }

  async function help(game: GuideGame): Promise<CommandReply> {
    const files = await pack(game, $t("role-references.text_a57cfcb842"), false);
    const text = game === "gs" ? genshinHelp : starrailHelp;
    if (!files.length) {
      if (game === "sr") {
        const archived = await historicalReference();
        if (Array.isArray(archived)) return [...archived, ...text];
      }
      return text.join("\n");
    }
    return [{ type: "image", file: files[0]!.bytes }, ...text];
  }

  async function reference(game: GuideGame, name: string, useHistorical = false): Promise<CommandReply | undefined> {
    const files = await pack(game, name, false);
    const toImage = (file: { readonly bytes: Buffer }) => ({ type: "image" as const, file: file.bytes });
    const refs = files.filter((file) => file.source.startsWith("RefStat:") && file.source !== referenceNotes).map(toImage);
    const curves = files.filter((file) => file.source.startsWith("YieldCurve:")).map(toImage);
    const first = refs.shift() ?? curves.shift();
    if (!first) {
      if (useHistorical && game === "sr") {
        const archived = await historicalReference(name);
        if (archived !== undefined) return archived;
      }
      return $t("role-references.text_0debbb8962", { "name": name });
    }
    const notes = readNotes(files.find((file) => file.source === referenceNotes)?.bytes, name);
    const heading = [first, ...(notes?.url ? [notes.url] : [])];
    const nodes: MessageReply[] = [
      heading, ...refs, ...(notes?.arti ? [notes.arti] : []), ...curves, ...(notes?.brief ? [notes.brief] : []),
    ];
    if (nodes.length === 1) return heading;
    const title = $t("role-references.text_91a4a78b0f", { "name": name });
    if (options.forward !== false) return { type: "forward", nodes: [title, ...nodes] };
    return [title, ...heading, ...refs, ...(notes?.arti ? [notes.arti] : []), ...curves, ...(notes?.brief ? [notes.brief] : [])];
  }

  function resolveCurrent(game: GuideGame, query: string, onlyHistorical: boolean, useHistorical: boolean) {
    function answer(role: ReturnType<typeof resolveGuideRole>) {
      if (typeof role === "string") return role.replaceAll("攻略", game === "sr" ? $t("role-references.text_39c688b722") : $t("role-references.text_8e1a0b634e"));
      if (role && safeGuideName(role.name)) {
        if (!onlyHistorical) return reference(game, role.name, useHistorical);
        return historicalReference(role.name).then(reply => reply ??
          (options.signal?.aborted ? undefined : $t("role-references.text_a87ab2d5e8", { "name": role.name })));
      }
    }
    const role = resolveGuideRole(query, game);
    if (role || !useHistorical) return answer(role);
    async function historicalAlias() {
      const aliases = options.settingsRoot
        ? await readGameCharacterAliases("sr", fileURLToPath(options.settingsRoot)) : undefined;
      const canonical = aliases?.get(characterAliasKey(query)) ?? historicalAliases.get(guideKey(query));
      return canonical ? answer(resolveGuideRole(canonical, "sr")) : undefined;
    }
    return historicalAlias();
  }

  return (message: string): CommandReply | Promise<CommandReply | undefined> | undefined => {
    const command = normalizeStarRailGuideCommand(message);
    if (/^#?星铁参考面板$/u.test(command)) return starrailHelp.join("\n");
    if (/^#?星铁历史参考面板帮助$/u.test(command)) {
      return historicalReference().then(reply => reply ?? starrailHelp.join("\n"));
    }
    const instructions = /^#?(星铁|原神)?(收益曲线|参考面板)帮助$/u.exec(command);
    if (instructions) return help(instructions[1] === "星铁" ? "sr" : "gs");
    const publicReference = /^#?星铁\s*(历史\s*)?(.+?)\s*参考面板$/u.exec(command);
    if (publicReference) {
      const query = publicReference[2]!.trim();
      if (!query || /\d{9,}|[\p{Cc}\p{Cf}]/u.test(query) || query.length > 60) return;
      return resolveCurrent("sr", query, !!publicReference[1], true);
    }
    const match = /^#?(星铁|原神)?(\S+?)(?:参考面板|收益曲线|进阶(?:攻略|参考)?)$/u.exec(command);
    if (match?.[2]) return resolveCurrent(match[1] === "星铁" ? "sr" : "gs", match[2], false, false);
  };
}
