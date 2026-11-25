import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
// Adapted from Mora-Plugin model/team.js and model/commonTools.js.
// Original author Rrrrrrray. GPLv3, see LICENSE.
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { CommandReply } from "../../lib/commands.ts";
import { alias } from "./genshin-guide-aliases.ts";
import characterNames from "./genshin-guide-names.json";

type Team = { readonly alias: readonly string[]; readonly role: readonly string[] };
type TeamIndex = {
  readonly 茗血茶: Readonly<Record<string, Team>>;
  readonly 卡玛sei亚: Readonly<Record<string, readonly string[]>>;
};

const travelerNames = ["空", "荧", "旅行者"];
const travelerElements = ["风主", "岩主", "雷主", "草主", "水主", "火主", "冰主"];
const roleNames = new Map<string, string>();
for (const [id, name] of Object.entries(characterNames)) {
  roleNames.set(id, name);
  roleNames.set(name.toLowerCase(), name);
}
for (const [name, aliases] of Object.entries(alias)) {
  for (const item of aliases.split(",")) roleNames.set(item.trim().toLowerCase(), name);
}

function dictionary(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error($t("team-guides.text_06d1ffa3d8"));
  }
  return value as Record<string, unknown>;
}

function names(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new Error($t("team-guides.text_06d1ffa3d8"));
  }
  return value;
}

function teamIndex(yaml: string): TeamIndex {
  const data = dictionary(Bun.YAML.parse(yaml));
  return {
    茗血茶: Object.fromEntries(Object.entries(dictionary(data.茗血茶)).map(([name, value]) => {
      const entry = dictionary(value);
      return [name, { alias: names(entry.alias), role: names(entry.role) }];
    })),
    卡玛sei亚: Object.fromEntries(Object.entries(dictionary(data.卡玛sei亚)).map(([name, roles]) => [name, names(roles)])),
  };
}

export const teamGuideAuthors = ["茗血茶", "卡玛sei亚"] as const;

export function indexedTeamImages(yaml: string): string[] {
  const index = teamIndex(yaml);
  return teamGuideAuthors.flatMap((author) => Object.keys(index[author]).map((name) => `${author}/${name}.png`));
}

function searchTeams(teams: TeamIndex, query: string) {
  if (query.endsWith("队")) query = query.replace("队", "");
  if (!query) return { images: [] };
  const tea = Object.entries(teams.茗血茶);
  const findByTeamName = tea.filter(([name]) => name.includes(query));
  const findByAlias = tea.filter(([, team]) => team.alias.includes(query));

  const roleAlias = query.replace(/#|老婆|老公|(18|[1-9])[0-9]{8}/gu, "").trim();
  const element = travelerElements.includes(roleAlias);
  const role = element ? roleAlias : roleNames.get(roleAlias.toLowerCase()) ?? roleAlias;
  if (travelerNames.includes(role) || /^(?:[风岩雷草水火冰])(?:旅行者|主角|空|荧|爷)$/u.test(role)) {
    return { traveler: $t("team-guides.text_55c213041f", { "query": query, "value2": travelerElements.map((name) => $t("team-guides.text_380ec1b133", { "name": name })).join("、") }) };
  }

  const findByRole = tea.filter(([, team]) => team.role.includes(role));
  const teaNames = new Set([...findByTeamName, ...findByAlias, ...findByRole].map(([name]) => name));
  const kamaNames = Object.entries(teams.卡玛sei亚).filter(([, roles]) => roles.includes(role)).map(([name]) => name);
  return {
    images: [
      ...[...teaNames].map((name) => ["茗血茶", name] as const),
      ...kamaNames.map((name) => ["卡玛sei亚", name] as const),
    ],
  };
}

export async function readResourceSnapshot(root: string, file: string, limit: number) {
  const path = await realpath(file);
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error($t("team-guides.text_af431e2651"));
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size === 0 || info.size > limit) throw new Error($t("team-guides.text_f43c76d869"));
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error($t("team-guides.text_9e0281de7e"));
    return { bytes: buffer.subarray(0, offset), modifiedAt: info.mtimeMs };
  } finally {
    await handle.close();
  }
}

export async function readResource(root: string, file: string, limit: number): Promise<Buffer> {
  return (await readResourceSnapshot(root, file, limit)).bytes;
}

export async function teamGuides(directory: string, query: string, forward: boolean): Promise<CommandReply> {
  let root: string;
  let teams: TeamIndex;
  try {
    root = await realpath(directory);
    teams = teamIndex((await readResource(root, join(root, "teamGuides.yaml"), 1024 * 1024)).toString("utf8"));
  } catch {
    return $t("team-guides.text_98ff4363f1");
  }

  const match = searchTeams(teams, query);
  if (match.traveler) return match.traveler;
  if (!match.images?.length) return $t("team-guides.text_b992115dc4", { "query": query });

  const images = [];
  for (const [author, name] of match.images) {
    if (/[\\/\u0000]/u.test(name)) continue;
    try {
      const file = await readResource(root, join(root, author, `${name}.png`), 16 * 1024 * 1024);
      if (file.subarray(0, 8).equals(pngHeader)) images.push({ type: "image" as const, file });
    } catch {
      continue;
    }
  }
  const [single, ...rest] = images;
  if (!single) return $t("team-guides.text_960c0db897");
  if (!rest.length) return single;
  const title = $t("team-guides.text_2511a2f3b2", { "query": query });
  return forward ? { type: "forward", nodes: [title, ...images] } : [title, ...images];
}

export const pngHeader = Buffer.from("89504e470d0a1a0a", "hex");
