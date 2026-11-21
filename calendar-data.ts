// Adapted from Miao-Plugin apps/wiki/Calendar.js and CalendarSr.js (MIT).
export const calendarListUrl = "https://hkrpg-api.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnList?game=hkrpg&game_biz=hkrpg_cn&lang=zh-cn&auth_appid=announcement&authkey_ver=1&bundle_id=hkrpg_cn&channel_id=1&level=65&platform=pc&region=prod_gf_cn&sdk_presentation_style=fullscreen&sdk_screen_transparent=true&sign_type=2&uid=100000000";
export const calendarContentUrl = "https://hkrpg-api-static.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnContent?game=hkrpg&game_biz=hkrpg_cn&lang=zh-cn&bundle_id=hkrpg_cn&platform=pc&region=prod_gf_cn&level=65&channel_id=1";
const gsBase = "https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api";
const gsQuery = "game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&region=cn_gf01&level=55&uid=100000000";
export const genshinCalendarListUrl = `${gsBase}/getAnnList?${gsQuery}`;
export const genshinCalendarContentUrl = `${gsBase}/getAnnContent?${gsQuery}`;
export const zzzCalendarListUrl = "https://announcement-api.mihoyo.com/common/nap_cn/announcement/api/getAnnList?game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&channel_id=1&level=70&platform=pc&region=prod_gf_cn&uid=12345678";
export const zzzCalendarContentUrl = "https://announcement-static.mihoyo.com/common/nap_cn/announcement/api/getAnnContent?game=nap&game_biz=nap_cn&lang=zh-cn&bundle_id=nap_cn&platform=pc&region=prod_gf_cn&level=70&channel_id=1";
const day = 86_400_000;
const china = 8 * 3_600_000;
const ignore = /(更新概览|游戏优化|优化说明|内容专题页|专题展示页|版本更新说明|循星归程|调研|防沉迷|米游社|专项意见|更新修复与优化|问卷调查|有奖问卷|版本更新通知|更新时间说明|预下载功能|周边限时|周边上新|角色演示|角色PV|版本PV|动画短片|bilibili|激励计划|调整说明|攻略征集|测试招募)/u;
const ignoreIds = new Set([257, 194, 203, 183, 187, 185, 171]);
const gsIgnoreIds = new Set([495, 1263, 423, 422, 762]);
const gsIgnore = /(内容专题页|版本更新说明|调研|防沉迷|米游社|专项意见|更新修复与优化|问卷调查|版本更新通知|更新时间说明|预下载功能|周边限时|周边上新|角色演示)/u;
const zzzIgnore = /(测试1|测试2|养成指南|签到福利|绘画征集|活动日历|新品情报|更新公告|更新说明|预约活动|云·绝区零|新剧情|问题修复|已知问题|攻略征集|丽都殊荣|商城|绳网认证分部一览|公平运营声明|防沉迷系统公告|米游社《绝区零》专属工具一览)/u;
const dateText = "\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}\\s+\\d{1,2}:\\d{2}(?::\\d{2})?";
const datePattern = new RegExp(dateText, "gu");
const activityHead = /(活动时间|活动跃迁时间|开启时间|上架时间|折扣时间|开放时间|限时活动期|领取时间)\s*[:：]?/gu;
const challengeNames = ["混沌回忆", "虚构叙事", "末日幻影", "异相仲裁"] as const;

export type CalendarGame = "genshin" | "starrail" | "zzz";
export type CalendarKind = "character" | "tuning" | "weapon" | "weapon2" | "bangboo" | "chronicled" | "pass" | "normal" | "activity" | "abyss" | "newAbyss" |
  "abyss-1" | "abyss-2" | "abyss-3" | "abyss-4";
export interface CalendarRow {
  readonly title: string;
  readonly kind: CalendarKind;
  readonly start: number;
  readonly end: number;
  readonly earliestEnd?: number;
  readonly wishDeadline?: number;
  readonly permanent?: boolean;
  readonly startUnverified?: boolean;
  readonly banner?: string;
  readonly icon?: string;
  readonly character?: string;
}
export interface CalendarData {
  readonly rows: readonly CalendarRow[];
  readonly now: number;
  readonly start: number;
  readonly end: number;
  readonly updated: number;
  readonly stale: boolean;
  readonly detailsAvailable: boolean;
}

interface CalendarPeriod {
  readonly start?: number;
  readonly end: number;
  readonly permanent: boolean;
  readonly startUnverified?: boolean;
  readonly wishDeadline?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function records(value: unknown) {
  return Array.isArray(value) ? value.map(record) : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function plain(value: unknown) {
  return string(value).replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replace(/<[^>]+>/gu, " ").replaceAll("&nbsp;", " ").replaceAll("&amp;", "&").replace(/\s+/gu, " ").trim();
}

export function calendarTime(value: unknown): number | undefined {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(string(value).trim());
  if (!match) return;
  const [y, m, d, h, min, s] = match.slice(1).map((part) => Number(part ?? 0)) as [number, number, number, number, number, number];
  if (y < 2023 || y > 2099 || m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59 || s > 59) return;
  const time = Date.UTC(y, m - 1, d, h, min, s);
  if (new Date(time).getUTCDate() === d) return time - china;
}

export function officialCalendarImage(value: unknown) {
  try {
    const url = new URL(string(value));
    if (url.protocol === "https:" && url.hostname === "sdk-webstatic.mihoyo.com" && !url.username && !url.password && !url.port) {
      return url.href;
    }
  } catch {}
}

function publicData(value: unknown, keys: readonly string[]) {
  const response = record(value);
  const data = record(response.data);
  if (response.retcode !== 0 || !keys.every((key) => Array.isArray(data[key]))) throw new Error("游戏公告响应格式变化。");
  return data;
}

function versionStarts(details: readonly Record<string, unknown>[], game: CalendarGame) {
  const starts = new Map<string, number>();
  for (const item of details) {
    const zz = game === "zzz";
    const pattern = game === "genshin" ? /(\d+\.\d+|「[^」]+」)版本更新(?:通知|说明|维护预告)/u
      : /^(\d+\.\d+)版本.*更新(?:概览|说明|维护预告)/u;
    const version = pattern.exec(plain(zz ? item.subtitle : item.title))?.[1];
    if (!version) continue;
    const text = plain(item.content);
    const update = (zz ? /更新开始时间[】\s:：]*([^【]{1,140})/u : /更新时间\s*[〓:：]?\s*([^〓■※]{1,140})/u).exec(text)?.[1];
    const start = update && calendarTime(update.match(datePattern)?.[0]);
    const hours = update && /预计\s*(\d{1,2})\s*个?小时/u.exec(update)?.[1];
    if (typeof start === "number" && hours) starts.set(version, start + Number(hours) * 3_600_000);
  }
  return starts;
}

function zzzInterval(text: string, versions: ReadonlyMap<string, number>): CalendarPeriod | undefined {
  const clean = text.replaceAll("（服务器时间）", "").replaceAll("(服务器时间)", "");
  const heading = /(?:调频活动时间|活动时间|开放时间|开启时间|折扣时间|上架时间|挑战时间)\s*(?:为|限定)?[】\s:：]*/gu;
  const explicit = new RegExp(`^(${dateText})\\s*[-~～至]\\s*(${dateText})`, "u");
  const after = new RegExp(`^(\\d+\\.\\d+)版本更新(?:完成)?后\\s*[-~～至]\\s*(${dateText})`, "u");
  for (const match of clean.matchAll(heading)) {
    const section = clean.slice(match.index + match[0].length, match.index + match[0].length + 145);
    const dates = explicit.exec(section);
    const version = after.exec(section);
    const permanent = /^(\d+\.\d+)版本更新(?:完成)?后\s*永久/u.exec(section);
    const start = dates ? calendarTime(dates[1]) : versions.get(version?.[1] ?? permanent?.[1] ?? "");
    const end = dates ? calendarTime(dates[2]) : version ? calendarTime(version[2]) :
      permanent ? calendarTime("2099/01/01 00:00:00") : undefined;
    if (start !== undefined && end !== undefined && end > start) return { start, end, permanent: !!permanent };
    if (version && start === undefined && end !== undefined) return { end, permanent: false, startUnverified: true };
  }
}

function genshinInterval(text: string, versions: ReadonlyMap<string, number>, listedEnd: number | undefined) {
  const headings = /〓(活动时间|祈愿介绍|任务开放时间|折扣时间|挑战时间)〓\s*([^〓]+)/gu;
  const explicit = new RegExp(`(${dateText})\\s*[-~～至]\\s*(${dateText})`, "u");
  const afterVersion = new RegExp(`(\\d+\\.\\d+|「[^」]+」)版本更新(?:完成)?后\\s*[-~～至]\\s*(${dateText})`, "u");
  for (const [, heading, section] of text.matchAll(headings)) {
    if (!section) continue;
    const interval = explicit.exec(section);
    const version = afterVersion.exec(section);
    const persistent = /(\d+\.\d+|「[^」]+」)版本更新(?:完成)?后\s*永久开放/u.exec(section);
    const throughout = /(\d+\.\d+|「[^」]+」)版本期间持续开放/u.exec(section);
    const start = interval ? calendarTime(interval[1]) : versions.get(version?.[1] ?? persistent?.[1] ?? throughout?.[1] ?? "");
    const end = interval ? calendarTime(interval[2]) : version ? calendarTime(version[2]) :
      persistent ? calendarTime("2099/01/01 00:00:00") : throughout ? listedEnd : undefined;
    if (start !== undefined && end !== undefined && end > start) {
      const finish = interval?.[2] ?? version?.[2];
      const wishDeadline = finish && (heading === "祈愿介绍" || heading === "活动时间")
        ? end + (/:\d{2}:\d{2}$/u.test(finish) ? 1_000 : 60_000) : undefined;
      return { start, end, permanent: !!persistent, wishDeadline };
    }
  }
}

function detailInterval(text: string, versions: ReadonlyMap<string, number>) {
  for (const match of text.matchAll(activityHead)) {
    const section = text.slice(match.index + match[0].length, match.index + match[0].length + 165)
      .split(/参与条件|开启条件|开放条件|领取条件|活动奖励|活动说明|活动规则|■|※/u, 1)[0] ?? "";
    const afterUpdate = /^(\d+\.\d+)版本更新(?:完成)?后/u.exec(section)?.[1];
    const dates = section.match(datePattern)?.map(calendarTime) ?? [];
    const start = afterUpdate ? versions.get(afterUpdate) : dates[0];
    const permanent = /永久开放/u.test(section);
    const end = permanent
      ? calendarTime("2099/01/01 00:00:00")
      : afterUpdate ? dates[0] : dates[1];
    if (start !== undefined && end !== undefined && end > start) return { start, end, permanent };
  }
}

function warpInterval(text: string, end: number | undefined, versions: ReadonlyMap<string, number>) {
  const pattern = new RegExp(`跃迁时间\\s*(?:为|[:：])?\\s*(\\d+\\.\\d+)版本更新(?:完成)?后\\s*[-~～至]\\s*(${dateText})`, "gu");
  const periods = new Map<number, number>();
  for (const row of text.matchAll(pattern)) {
    const start = row[1] && versions.get(row[1]);
    const stop = calendarTime(row[2]);
    if (typeof start === "number" && stop !== undefined && stop > start) periods.set(stop, start);
  }
  const start = end !== undefined ? periods.get(end) : undefined;
  if (start === undefined) return;
  const ends = [...periods].filter(([, begins]) => begins === start).map(([stop]) => stop);
  const earliestEnd = Math.min(...ends);
  const finalEnd = Math.max(...ends);
  return { start, end: finalEnd, earliestEnd: earliestEnd < finalEnd ? earliestEnd : undefined };
}

function kindFor(title: string): CalendarKind {
  const index = challengeNames.findIndex((name) => title.startsWith(name) || title.startsWith("「" + name));
  if (index !== -1) return `abyss-${index + 1}` as CalendarKind;
  if (title.includes("流光定影")) return "weapon";
  if (title.includes("活动跃迁")) return "character";
  if (title.includes("无名勋礼")) return "pass";
  return "activity";
}

function genshinKind(title: string, activity: boolean): CalendarKind {
  if (/^(?:[「『])?幻想真境剧诗/u.test(title)) return "newAbyss";
  if (/^(?:[「『])?深境螺旋/u.test(title)) return "abyss";
  if (/集录祈愿/u.test(title)) return "chronicled";
  if (/祈愿/u.test(title) && /概率UP/u.test(title)) return /单手剑|双手剑|长柄武器|弓·|法器·/u.test(title) ? "weapon" : "character";
  if (/纪行/u.test(title)) return "pass";
  return activity ? "activity" : "normal";
}

function zzzKind(title: string): CalendarKind {
  if (/^(?:[「『])?剧变节点/u.test(title)) return "abyss-1";
  if (/^(?:[「『])?危局强袭/u.test(title)) return "abyss-2";
  if (/限时频段/u.test(title)) return "tuning";
  if (/喧哗奏鸣/u.test(title)) return "weapon";
  if (/灿烂和声/u.test(title)) return "weapon2";
  if (/卓越搭档/u.test(title)) return "bangboo";
  if (/调频/u.test(title)) return "character";
  if (/丽都城募/u.test(title)) return "pass";
  return "activity";
}

function snapshot(list: unknown, detail: unknown, updated: number, game: CalendarGame) {
  const gs = game === "genshin";
  const zz = game === "zzz";
  const source = publicData(list, gs ? ["list"] : ["list", "pic_list"]);
  if (source.timezone !== undefined && source.timezone !== 8) throw new Error("游戏公告时区变化。");
  const sections = records(source.list);
  const gsSections = sections.filter(({ type_label }) => type_label === "游戏公告" || type_label === "活动公告");
  const notices = gs ? (gsSections.length ? gsSections : sections.slice(0, 2))
    .flatMap((entry, index) => records(entry.list).map((item) => ({
      item, activity: gsSections.length ? entry.type_label === "活动公告" : index === 1,
    }))) : [
    ...sections.flatMap((entry) => records(entry.list)),
    ...records(source.pic_list).flatMap((entry) => records(entry.type_list).flatMap((group) => records(group.list)))
      .filter((item) => !zz || /活动|限时频段|调频|卓越搭档|剧变节点|危局强袭/u.test(plain(item.title))),
  ].map((item) => ({ item, activity: true }));
  if (!notices.some(({ item }) => typeof item.ann_id === "number" && typeof item.start_time === "string")) {
    throw new Error("游戏公告列表没有可识别的活动。");
  }
  let details: Record<string, unknown>[] = [];
  let detailsAvailable = false;
  try {
    const content = publicData(detail, gs ? ["list"] : ["list", "pic_list"]);
    details = [...records(content.list), ...records(content.pic_list)];
    detailsAvailable = details.length > 0;
  } catch {}
  const versions = versionStarts(details, game);
  const byKey = new Map(details.map((item) => [JSON.stringify([item.ann_id, plain(item.title)]), item]));
  const rows = new Map<string, CalendarRow>();
  for (const { item, activity } of notices) {
    const id = item.ann_id;
    let title = plain(item.title);
    if (typeof id !== "number" || !title || (!zz && (gs ? gsIgnoreIds : ignoreIds).has(id)) ||
        (gs ? gsIgnore : zz ? zzzIgnore : ignore).test(title)) continue;
    const key = JSON.stringify([id, title]);
    if (rows.has(key)) continue;
    const notice = byKey.get(key);
    const kind = gs ? genshinKind(title, activity) : zz ? zzzKind(title) : kindFor(title);
    const text = plain(notice?.content);
    const listedEnd = calendarTime(item.end_time);
    const advertised: CalendarPeriod | undefined = gs ? genshinInterval(text, versions, listedEnd) :
      zz ? zzzInterval(text, versions) : detailInterval(text, versions);
    if ((kind.startsWith("abyss") || kind === "newAbyss") && advertised?.start === undefined) continue;
    const warp = game === "starrail" && (kind === "character" || kind === "weapon") ? warpInterval(text, listedEnd, versions) : undefined;
    const start = advertised?.start ?? warp?.start ?? calendarTime(item.start_time);
    const end = advertised?.end ?? warp?.end ?? listedEnd;
    if (start === undefined || end === undefined || end <= start) continue;
    const character = gs && kind === "character" ? /·([^·(（」]+)[(（]/u.exec(title)?.[1] : undefined;
    if (gs && kind === "weapon") title = title.replace(/(?:单手剑|双手剑|长柄武器|弓|法器)·/gu, "");
    if (zz) title = title.replace(/(调频|活动|上新)(?:说明|公告)/gu, "$1").replace(/[」](?:说明|公告)/gu, "」");
    const wish = gs && (kind === "character" || kind === "weapon" || kind === "chronicled") && /^「[^」]+」祈愿[：:]/u.test(title);
    rows.set(key, {
      title, kind, start, end, permanent: advertised?.permanent, startUnverified: advertised?.startUnverified,
      earliestEnd: advertised ? undefined : warp?.earliestEnd,
      ...(wish && advertised?.wishDeadline !== undefined && { wishDeadline: advertised.wishDeadline }),
      banner: !gs || activity ? officialCalendarImage(item.banner) ?? officialCalendarImage(item.img) ?? officialCalendarImage(notice?.img) : undefined,
      icon: officialCalendarImage(item.tag_icon), character,
    });
  }
  return { rows: [...rows.values()], updated, detailsAvailable };
}

const order: Record<CalendarKind, number> = {
  abyss: 0, newAbyss: 0, "abyss-1": 0, "abyss-2": 0, "abyss-3": 0, "abyss-4": 0,
  character: 1, tuning: 1, chronicled: 2, weapon: 3, weapon2: 3, bangboo: 4, pass: 5, activity: 5, normal: 10,
};

export function calendarWindow(data: ReturnType<typeof snapshot>, now: number, stale = false): CalendarData {
  const start = Math.floor((now + china) / day) * day - china - 6 * day;
  const end = start + 13 * day;
  const rows = data.rows.filter((row) => row.start < end && row.end > start)
    .sort((a, b) => order[a.kind] - order[b.kind] || a.start - b.start || a.end - b.end).slice(0, 60);
  return { ...data, rows, start, end, now, stale };
}

export function buildStarrailCalendar(list: unknown, content: unknown, now: number): CalendarData {
  return calendarWindow(snapshot(list, content, now, "starrail"), now);
}

export function buildGenshinCalendar(list: unknown, content: unknown, now: number): CalendarData {
  return calendarWindow(snapshot(list, content, now, "genshin"), now);
}

export function buildZzzCalendar(list: unknown, content: unknown, now: number): CalendarData {
  return calendarWindow(snapshot(list, content, now, "zzz"), now);
}

export async function readCalendarBytes(response: Response, limit: number) {
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error("无法访问游戏官方公告。");
  }
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks, size);
      size += chunk.value.length;
      if (size > limit) throw new Error("游戏公告响应超限。");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function calendarTransport(transport: typeof fetch, active?: AbortSignal) {
  return (url: string) => {
    const timeout = AbortSignal.timeout(12_000);
    const signal = active ? AbortSignal.any([active, timeout]) : timeout;
    return transport(url, { signal, redirect: "error", credentials: "omit" });
  };
}

export async function readCalendarJson(response: Response) {
  return JSON.parse((await readCalendarBytes(response, 4 * 1024 * 1024)).toString("utf8")) as unknown;
}

export function createCalendarSource(game: CalendarGame, options: {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
} = {}) {
  const transport = calendarTransport(options.fetch ?? fetch, options.signal);
  const [listUrl, contentUrl] = ({
    genshin: [genshinCalendarListUrl, genshinCalendarContentUrl], starrail: [calendarListUrl, calendarContentUrl],
    zzz: [zzzCalendarListUrl, zzzCalendarContentUrl],
  } as const)[game];
  const now = options.now ?? Date.now;
  let retained: ReturnType<typeof snapshot> | undefined;
  let active: Promise<ReturnType<typeof snapshot>> | undefined;
  const request = (url: string) => transport(url).then(readCalendarJson);
  return async () => {
    const time = now();
    if (retained && time - retained.updated < (retained.detailsAvailable ? 600_000 : 60_000)) {
      return calendarWindow(retained, time);
    }
    active ??= Promise.all([request(listUrl), request(contentUrl).catch(() => undefined)])
      .then(([list, detail]) => retained = snapshot(list, detail, now(), game)).finally(() => { active = undefined; });
    try {
      return calendarWindow(await active, now());
    } catch (error) {
      if (retained && time - retained.updated < 6 * 3_600_000) return calendarWindow(retained, time, true);
      throw error;
    }
  };
}

export const createStarrailCalendarSource = (options?: Parameters<typeof createCalendarSource>[1]) => createCalendarSource("starrail", options);
export const createGenshinCalendarSource = (options?: Parameters<typeof createCalendarSource>[1]) => createCalendarSource("genshin", options);
