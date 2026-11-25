import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
import { builtinResourceDirectory } from "../../lib/builtin-resources.ts";
import { transientReadResponse, withReadRetries } from "@lotus-yunzai/http";
import type { MessageSegment } from "../../lib/messages.ts";
import type { AkashaCard, drawAkashaCard } from "./akasha-card.ts";
import { resolveGuideRole } from "./role-guide-input.ts";
import { isGuideImage, readGuideImage } from "./role-image-files.ts";

const origin = "https://akashadata.com";
const sourceAge = 30 * 86_400_000;
const refreshInterval = 10 * 60_000;
const teamPageSize = 14;
const helpImage = "img/AkashaHelp.png";
const helpText = [
  $t("akasha-abyss.text_1f3846e427"),
  $t("akasha-abyss.text_7f44f9d2f0"),
  $t("akasha-abyss.text_dd1c9de2f2"),
  "#虚空深渊上半队伍出战数1",
  "#虚空深渊下半队伍满星率2",
  $t("akasha-abyss.text_b758e9f2f6"),
].join("\n");

type Row = Record<string, unknown>;
type Transport = (url: string, options: RequestInit & { readonly proxy?: false }) => Promise<Response>;
type Character = { readonly name: string; readonly portraitName?: string; readonly rarity: number; readonly rate: number };
type Team = { readonly names: readonly string[]; readonly count: number; readonly full: number; readonly ratio: string };
type Half = "全部" | "上半" | "下半";
type Query =
  | { readonly type: "help" }
  | { readonly type: "usage"; readonly rarity?: 4 | 5 }
  | { readonly type: "teams"; readonly half: Half; readonly sort: "出战数" | "满星率"; readonly page: number };

function record(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError($t("akasha-abyss.text_5ef4c1efb6"));
  return value as Row;
}

function rows(input: unknown) {
  if (!Array.isArray(input) || !input.length || input.length > 500) throw new TypeError($t("akasha-abyss.text_6814649ec6"));
  return input.map(record);
}

function string(value: unknown, pattern: RegExp) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError($t("akasha-abyss.text_d995a45872"));
  return value;
}

function number(value: unknown, maximum: number, integer = false) {
  const parsed = typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0 || parsed > maximum ||
      (integer && !Number.isSafeInteger(parsed))) throw new TypeError($t("akasha-abyss.text_e2679c710a"));
  return parsed;
}

const characterName = /^[\p{L}\p{N}·（）() -]{1,25}$/u;

export function matchAkashaAbyss(message: string): Query | undefined {
  if (/^#?虚空深渊帮助$/u.test(message)) return { type: "help" };
  const usage = /^#?虚空(?:深渊)?(五星|四星)?使用率$/u.exec(message);
  if (usage) return { type: "usage", rarity: usage[1] === "五星" ? 5 : usage[1] === "四星" ? 4 : undefined };
  const team = /^#?虚空(?:深渊)?(上半|下半)?队伍(出战数|满星率)?([1-7])?$/u.exec(message);
  if (team) return { type: "teams", half: team[1] === "上半" ? "上半" : team[1] === "下半" ? "下半" : "全部",
    sort: team[2] === "满星率" ? "满星率" : "出战数", page: Number(team[3] ?? 1) };
}

function parseAssignment(buffer: Buffer, variable: "static_abyss_total" | "static_card_dict") {
  const text = buffer.toString("utf8").trim();
  const assignment = new RegExp(`^(?:var|let|const)\\s+${variable}\\s*=\\s*(\\{[\\s\\S]*\\})\\s*;?$`, "u").exec(text);
  if (!assignment) throw new TypeError($t("akasha-abyss.text_bd02cc06f3"));
  return record(JSON.parse(assignment[1]!));
}

function snapshot(total: Buffer, dictionary: Buffer) {
  const data = parseAssignment(total, "static_abyss_total");
  const names = parseAssignment(dictionary, "static_card_dict");
  const date = string(data.modify_time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/u);
  const timestamp = Date.parse(date.replace(" ", "T") + "+08:00");
  if (!Number.isFinite(timestamp)) throw new TypeError($t("akasha-abyss.text_4b4bc73dc1"));
  const version = string(data.schedule_version_desc, /^[\p{L}\p{N} .（）()-]{1,30}$/u);
  const characters: readonly Character[] = rows(data.character_used_list).map(character => {
    const rarity = number(character.rarity, 5, true);
    if (rarity !== 4 && rarity !== 5) throw new TypeError($t("akasha-abyss.text_2454def990"));
    const name = string(character.name, characterName);
    const role = resolveGuideRole(name, "gs");
    return { name, portraitName: typeof role === "object" && role.name !== name ? role.name : undefined,
      rarity, rate: number(character.value, 100) };
  });
  function teams(field: string, count: string, full: string): readonly Team[] {
    return rows(data[field]).map(team => {
      const lineup = team.tl;
      if (!Array.isArray(lineup) || !lineup.length || lineup.length > 4) throw new TypeError($t("akasha-abyss.text_2ca2d1e82b"));
      return {
        names: lineup.map(id => string(record(names[String(number(id, 100_000, true))]).name, characterName)),
        count: number(team[count], 10_000_000, true),
        full: number(team[full], 100),
        ratio: string(team.ud, /^\d{1,3}:\d{1,3}$/u),
      };
    });
  }
  return { version, date, timestamp, characters,
    teams: { 全部: teams("team_list", "ac", "mr"), 上半: teams("team_up_list", "uc", "umr"),
      下半: teams("team_down_list", "dc", "dmr") } };
}

async function fetchBytes(url: string, limit: number, request: Transport, signal: AbortSignal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(9_000)]);
  const options = { redirect: "error", credentials: "omit", signal: deadline } as const;
  let reply: Response;
  const base = (target: URL, init: RequestInit & { readonly proxy?: false }) => request(target.href, init);
  const once = withReadRetries(base, { attempts: 1 });
  const remaining = withReadRetries(base, { attempts: 2 });
  let usedFallback = false;
  try {
    reply = await once(new URL(url), options);
  } catch {
    deadline.throwIfAborted();
    usedFallback = true;
    reply = await remaining(new URL(url), { ...options, proxy: false });
  }
  if (!usedFallback && transientReadResponse(reply)) {
    await reply.body?.cancel().catch(() => {});
    // HTTP failures stay on the original route; only the existing network
    // failure fallback is allowed to switch this public source to direct.
    reply = await remaining(new URL(url), options);
  }
  if (!reply.ok || !reply.body || Number(reply.headers.get("content-length")) > limit) {
    await reply.body?.cancel();
    throw new Error($t("akasha-abyss.text_d5eca5d077"));
  }
  const chunks: Uint8Array[] = [];
  const reader = reply.body.getReader();
  let count = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > limit) throw new Error($t("akasha-abyss.text_d7ae308bdb"));
      chunks.push(value);
    }
    return Buffer.concat(chunks, count);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type Source = ReturnType<typeof snapshot>;
type ImageReply = Extract<MessageSegment, { type: "image" }>;

export function createAkashaAbyss({ signal, themes = [], transport = fetch, clock = Date.now,
  draw = async (...args) => (await import("./akasha-card.ts")).drawAkashaCard(...args) }: {
  readonly signal: AbortSignal;
  readonly themes?: readonly string[];
  readonly transport?: Transport;
  readonly clock?: () => number;
  readonly draw?: typeof drawAkashaCard;
}) {
  let pending: Promise<Source | undefined> | undefined;
  let previous: Source | undefined;
  let refreshAfter = 0;

  async function body() {
    if (!pending && clock() >= refreshAfter) {
      pending = Promise.all([fetchBytes(origin + "/static/data/abyss_total.js", 512 * 1024, transport, signal),
        fetchBytes(origin + "/xstatic/json/static_card_dict.js", 64 * 1024, transport, signal)])
        .then(([total, dictionary]) => previous = snapshot(total, dictionary))
        .catch(() => previous)
        .finally(() => { pending = undefined; refreshAfter = clock() + (previous ? refreshInterval : 30_000); });
    }
    return pending ? await pending : previous;
  }

  async function asset(path: string, bundled: boolean) {
    for (const root of [...themes, builtinResourceDirectory("social/guides")]) {
      const bytes = await readGuideImage(root, path);
      if (bytes) return bytes;
    }
    return undefined;
  }

  async function reply(query: Query, inlineLimit: number): Promise<ImageReply | string | undefined> {
    if (signal.aborted) return;
    if (query.type === "help") {
      const help = await asset(helpImage, true);
      if (signal.aborted) return;
      return help && help.length <= inlineLimit ? { type: "image", file: help } : helpText;
    }
    const source = await body();
    if (signal.aborted) return;
    if (!source) return $t("akasha-abyss.text_3835dbd27d");
    const lead = $t("akasha-abyss.text_b8adf97467", { "version": source.version });
    const meta = $t("akasha-abyss.text_57d32b4df7", { "date": source.date });
    const history = clock() - source.timestamp > sourceAge ? $t("akasha-abyss.text_fc9f1fdaa0") : undefined;
    let card: AkashaCard;
    if (query.type === "usage") {
      const characters = source.characters.filter(row => query.rarity === undefined || row.rarity === query.rarity);
      if (!characters.length) return $t("akasha-abyss.text_7ada4813e5", { "lead": lead });
      card = { type: "usage", lead, meta, history, label: query.rarity ? $t("akasha-abyss.text_8a56c6ab9d", { "rarity": query.rarity }) : $t("akasha-abyss.text_9a0c4b9c07"), characters };
    } else {
      const sorted = query.sort === "满星率" ? [...source.teams[query.half]].sort((a, b) => b.full - a.full) : source.teams[query.half];
      const offset = (query.page - 1) * teamPageSize;
      const teams = sorted.slice(offset, offset + teamPageSize);
      if (!teams.length) return $t("akasha-abyss.text_ac623ce2f3", { "lead": lead, "page": query.page });
      card = { type: "teams", lead, meta, history, label: $t("akasha-abyss.text_838ac0ba92", { "half": query.half, "sort": query.sort }),
        page: query.page, pageCount: Math.min(7, Math.ceil(sorted.length / teamPageSize)), teams };
    }
    const plain = (card.type === "usage"
      ? card.characters.map(row => `${row.name} ${row.rate.toFixed(1)}%`)
      : card.teams.map(row => $t("akasha-abyss.text_85032a4f47", { "value1": row.names.join("、"), "count": row.count, "value3": row.full.toFixed(2), "ratio": row.ratio }))).join("\n");
    const page = card.type === "teams" ? $t("akasha-abyss.text_54595f6d35", { "page": card.page, "pageCount": card.pageCount }) : undefined;
    const text = [lead, card.label, history, meta, page, plain].filter(Boolean).join("\n");
    const png = await draw(card, asset).catch(() => undefined);
    if (signal.aborted) return;
    return png && png.png.length <= inlineLimit ? { type: "image", file: new Uint8Array(png.png) } : text;
  }

  return (message: string, inlineLimit = Infinity) => {
    const query = matchAkashaAbyss(message);
    if (query) return reply(query, inlineLimit);
  };
}
