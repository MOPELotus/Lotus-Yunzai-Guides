// Reference panels and yield curves are from Mora-Plugin model/roleGuide.js.
import { join } from "node:path";
import type { CommandReply } from "../../lib/commands.ts";
import type { MessageReply } from "../../lib/messages.ts";
import { createRoleResourcePack, referenceNotes, type RolePackFallback } from "./role-resource-pack.ts";
import { resolveGuideRole, safeGuideName, type GuideGame } from "./role-guide-input.ts";

const genshinHelp = [
  "角色默认配置：五星0命，四星满命，天赋满级",
  "曲线详细帮助：\n收益曲线说明书：https://www.miyoushe.com/ys/article/28119112\n《属性收益论》：https://www.miyoushe.com/ys/article/34217426\n《属性收益论》附录：https://www.miyoushe.com/ys/article/35015246",
];
const starrailHelp = ["请使用【*希儿参考面板】或【#星铁罗刹参考面板】进行使用"];

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
      ? `圣遗物思路推荐：\n主词条：${info.mainProp}\n副词条：${info.viceProp}` : undefined;
    const brief = typeof info.brief === "string" ? `【蓝佬小课堂】：\n${info.brief}` : undefined;
    return { url, arti, brief };
  } catch {}
}

export function createRoleReferences(options: {
  readonly cache: string;
  readonly guidePack?: RolePackFallback;
  readonly signal?: AbortSignal;
  readonly forward?: boolean;
  readonly guideSource?: string;
}) {
  const pack = createRoleResourcePack({
    root: join(options.cache, "mora-reference"), references: true, fallback: options.guidePack,
    upstream: options.guideSource, signal: options.signal,
  });

  async function help(game: GuideGame): Promise<CommandReply> {
    const files = await pack(game, "帮助", false);
    const text = game === "gs" ? genshinHelp : starrailHelp;
    if (!files.length) return text.join("\n");
    return [{ type: "image", file: files[0]!.bytes }, ...text];
  }

  async function reference(game: GuideGame, name: string): Promise<CommandReply> {
    const files = await pack(game, name, false);
    const toImage = (file: { readonly bytes: Buffer }) => ({ type: "image" as const, file: file.bytes });
    const refs = files.filter((file) => file.source.startsWith("RefStat:") && file.source !== referenceNotes).map(toImage);
    const curves = files.filter((file) => file.source.startsWith("YieldCurve:")).map(toImage);
    const first = refs.shift() ?? curves.shift();
    if (!first) return `暂无${name}进阶参考捏`;
    const notes = readNotes(files.find((file) => file.source === referenceNotes)?.bytes, name);
    const heading = [first, ...(notes?.url ? [notes.url] : [])];
    const nodes: MessageReply[] = [
      heading, ...refs, ...(notes?.arti ? [notes.arti] : []), ...curves, ...(notes?.brief ? [notes.brief] : []),
    ];
    if (nodes.length === 1) return heading;
    const title = `${name}进阶参考 @blue菌hehe`;
    if (options.forward !== false) return { type: "forward", nodes: [title, ...nodes] };
    return [title, ...heading, ...refs, ...(notes?.arti ? [notes.arti] : []), ...curves, ...(notes?.brief ? [notes.brief] : [])];
  }

  return (message: string): CommandReply | Promise<CommandReply> | undefined => {
    const command = message.trim();
    const instructions = /^#?(星铁|原神)?(收益曲线|参考面板)帮助$/u.exec(command);
    if (instructions) return help(instructions[1] === "星铁" ? "sr" : "gs");
    const match = /^#?(星铁|原神)?(\S+?)(?:参考面板|收益曲线|进阶(?:攻略|参考)?)$/u.exec(command);
    if (!match?.[2]) return;
    const game = match[1] === "星铁" ? "sr" : "gs";
    const role = resolveGuideRole(match[2], game);
    if (typeof role === "string") return role.replaceAll("攻略", game === "sr" ? "参考面板" : "进阶参考");
    if (role && safeGuideName(role.name)) return reference(game, role.name);
  };
}
