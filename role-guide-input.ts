// The old role command and traveler names are from Mora-Plugin.
import { alias as genshinAliases } from "./genshin-guide-aliases.ts";
import genshinNames from "./genshin-guide-names.json";
import { alias as starrailAliases } from "./starrail-guide-aliases.ts";
import starrailNames from "./starrail-guide-names.json";

export const guideGames = {
  gs: { label: "原神", pack: "Genshin", config: "roleGuides.yaml" },
  sr: { label: "星铁", pack: "StarRail", config: "srRoleGuides.yaml" },
  zzz: { label: "绝区零", pack: "ZenlessZoneZero", config: "zzzRoleGuides.yaml" },
} as const;
export type GuideGame = keyof typeof guideGames;

const moraPackNames = Object.fromEntries(Object.entries(guideGames).map(([game, { pack }]) => [pack, game]));
const legacyMoraPackNames = Object.fromEntries(Object.entries(guideGames).map(([game, { pack }]) => [game, pack]));

export function moraSourcePath(path: string) {
  return path.replace(/^(Genshin|StarRail|ZenlessZoneZero)(?=\/|$)/u, pack => moraPackNames[pack] ?? pack);
}

export function canonicalMoraPath(path: string) {
  return path.replace(/^(gs|sr|zzz)(?=\/|$)/u, game => legacyMoraPackNames[game] ?? game);
}

const travelers = ["风主", "岩主", "雷主", "草主", "水主", "火主", "冰主"];
const trailblazers = [
  ["物", 8001, ["物", "物理", "毁灭"]],
  ["火", 8003, ["火", "存护"]],
  ["虚数", 8005, ["虚数", "同谐", "同协", "虚"]],
  ["冰", 8007, ["冰", "记忆"]],
  ["雷", 8009, ["雷", "欢愉"]],
] as const;

export function guideKey(value: string): string {
  return value.normalize("NFKC").replace(/[·‧•・]/gu, "·").toLowerCase();
}

export function safeGuideName(value: string): boolean {
  return !!value && value !== "." && value !== ".." && !/[\/\\\u0000-\u001f\u007f]/u.test(value);
}

function roles(names: Record<string, string>, aliases: Readonly<Record<string, string>>) {
  const result = new Map<string, { name: string; id: string }>();
  for (const [id, name] of Object.entries(names)) {
    result.set(id, { name, id });
    result.set(guideKey(name), { name, id });
  }
  for (const [name, alternatives] of Object.entries(aliases)) {
    const role = result.get(guideKey(name));
    if (role) for (const alias of alternatives.split(",")) result.set(guideKey(alias.trim()), role);
  }
  return result;
}

const gs = roles(genshinNames, genshinAliases);
const sr = roles(starrailNames, starrailAliases);

export type GuideRole = {
  readonly name: string;
  readonly id?: string;
  readonly topicWords?: readonly string[];
  readonly otherForms?: readonly string[];
};

const starrailForms = Object.values(starrailNames);

export function resolveGuideRole(query: string, game: GuideGame): GuideRole | string | undefined {
  const input = query.replace(/#|老婆|老公|(18|[1-9])[0-9]{8}/gu, "").trim();
  if (!safeGuideName(input)) return;
  if (game === "gs") {
    if (travelers.includes(input)) return { name: input };
    const role = gs.get(guideKey(input));
    if (role && ["10000005", "10000007", "20000000"].includes(role.id)) {
      return `请选择${input}攻略：${travelers.map((name) => `${name}攻略`).join("、")}`;
    }
    return role;
  }
  if (game === "sr") {
    if (/^(?:主|主角|爷|开拓者|星|穹)$/u.test(input)) {
      return `请选择${input}攻略：${trailblazers.map(([name]) => `${name}主攻略`).join("、")}`;
    }
    const role = sr.get(guideKey(input));
    for (const [element, id, aliases] of trailblazers) {
      const topicWords = aliases.flatMap((alias) => ["主", "主角", "爷", "开拓者"].map((suffix) => alias + suffix));
      if (topicWords.includes(input) || role?.id === String(id) || role?.id === String(id + 1)) {
        return { name: `${element}主`, id: role?.id ?? String(id), topicWords };
      }
    }
    if (!role) return;
    const prefix = guideKey(role.name) + "·";
    const otherForms = starrailForms.filter((name) => guideKey(name).startsWith(prefix));
    return { ...role, otherForms };
  }
  return { name: input };
}

export function normalizeStarRailGuideCommand(message: string) {
  return message.trim().replace(/^(?:#星铁sr|#?(?:[*＊]?sr|[*＊]))/u, "#星铁");
}

export function parseGuideCommand(command: string): { readonly game: GuideGame; readonly role: string;
  readonly update: boolean; readonly source?: number } | undefined {
  const input = normalizeStarRailGuideCommand(command);
  const starRail = /^#?星铁(更新)?(\S+?)攻略([0-3]|all)$/iu.exec(input);
  if (starRail) return { game: "sr", role: starRail[2]!, update: !!starRail[1],
    source: starRail[3]!.toLowerCase() === "all" ? 0 : Number(starRail[3]) };
  const numbered = /^#?(?:原神)?(更新)?(\S+?)攻略([1-7])$/u.exec(input);
  if (numbered && !/^(?:星铁|绝区零)/u.test(numbered[2]!)) {
    return { game: "gs", role: numbered[2]!, update: !!numbered[1], source: Number(numbered[3]) };
  }
  if (/(?:进阶攻略|图鉴攻略)$/u.test(command)) return;
  const match = /^#?(?:(星铁|绝区零|原神))?(更新)?(\S+?)(?:攻略|一图流)$/u.exec(input);
  if (!match || !match[3]) return;
  const game = match[1] === "星铁" ? "sr" : match[1] === "绝区零" ? "zzz" : "gs";
  return { game, role: match[3], update: !!match[2] } as const;
}
