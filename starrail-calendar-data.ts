// Adapted from Miao-Plugin apps/wiki/Calendar.js and CalendarSr.js (MIT).
export const calendarListUrl = "https://hkrpg-api.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnList?game=hkrpg&game_biz=hkrpg_cn&lang=zh-cn&auth_appid=announcement&authkey_ver=1&bundle_id=hkrpg_cn&channel_id=1&level=65&platform=pc&region=prod_gf_cn&sdk_presentation_style=fullscreen&sdk_screen_transparent=true&sign_type=2&uid=100000000";
export const calendarContentUrl = "https://hkrpg-api-static.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnContent?game=hkrpg&game_biz=hkrpg_cn&lang=zh-cn&bundle_id=hkrpg_cn&platform=pc&region=prod_gf_cn&level=65&channel_id=1";
const day = 86_400_000;
const china = 8 * 3_600_000;
const ignore = /(更新概览|游戏优化|优化说明|内容专题页|专题展示页|版本更新说明|循星归程|调研|防沉迷|米游社|专项意见|更新修复与优化|问卷调查|有奖问卷|版本更新通知|更新时间说明|预下载功能|周边限时|周边上新|角色演示|角色PV|版本PV|动画短片|bilibili|激励计划|调整说明|攻略征集|测试招募)/u;
const ignoreIds = new Set([257, 194, 203, 183, 187, 185, 171]);
const dateText = "\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}\\s+\\d{1,2}:\\d{2}(?::\\d{2})?";
const datePattern = new RegExp(dateText, "gu");
const activityHead = /(活动时间|活动跃迁时间|开启时间|上架时间|折扣时间|开放时间|限时活动期|领取时间)\s*[:：]?/gu;
const challengeNames = ["混沌回忆", "虚构叙事", "末日幻影", "异相仲裁"] as const;

export type CalendarKind = "character" | "weapon" | "pass" | "activity" | "abyss-1" | "abyss-2" | "abyss-3" | "abyss-4";
export interface CalendarRow {
  readonly title: string;
  readonly kind: CalendarKind;
  readonly start: number;
  readonly end: number;
  readonly earliestEnd?: number;
  readonly permanent?: boolean;
  readonly banner?: string;
  readonly icon?: string;
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
  if (response.retcode !== 0 || !keys.every((key) => Array.isArray(data[key]))) throw new Error("星铁公告响应格式变化。");
  return data;
}

function versionStarts(details: readonly Record<string, unknown>[]) {
  const starts = new Map<string, number>();
  for (const item of details) {
    const version = /^(\d+\.\d+)版本.*更新(?:概览|说明|维护预告)/u.exec(string(item.title))?.[1];
    if (!version) continue;
    const text = plain(item.content);
    const update = /更新时间\s*[:：]?\s*([^■※]{1,140})/u.exec(text)?.[1];
    const start = update && calendarTime(update.match(datePattern)?.[0]);
    const hours = update && /预计\s*(\d{1,2})\s*个?小时/u.exec(update)?.[1];
    if (typeof start === "number" && hours) starts.set(version, start + Number(hours) * 3_600_000);
  }
  return starts;
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

function snapshot(list: unknown, detail: unknown, updated: number) {
  const source = publicData(list, ["list", "pic_list"]);
  if (source.timezone !== undefined && source.timezone !== 8) throw new Error("星铁公告时区变化。");
  const notices = [
    ...records(source.list).flatMap((entry) => records(entry.list)),
    ...records(source.pic_list).flatMap((entry) => records(entry.type_list).flatMap((group) => records(group.list))),
  ];
  if (!notices.some((notice) => typeof notice.ann_id === "number" && typeof notice.start_time === "string")) {
    throw new Error("星铁公告列表没有可识别的活动。");
  }
  let details: Record<string, unknown>[] = [];
  let detailsAvailable = false;
  try {
    const content = publicData(detail, ["list", "pic_list"]);
    details = [...records(content.list), ...records(content.pic_list)];
    detailsAvailable = details.length > 0;
  } catch {}
  const versions = versionStarts(details);
  const byKey = new Map(details.map((item) => [JSON.stringify([item.ann_id, plain(item.title)]), item]));
  const rows = new Map<string, CalendarRow>();
  for (const item of notices) {
    const id = item.ann_id;
    const title = plain(item.title);
    if (typeof id !== "number" || !title || ignoreIds.has(id) || ignore.test(title)) continue;
    const key = JSON.stringify([id, title]);
    if (rows.has(key)) continue;
    const notice = byKey.get(key);
    const kind = kindFor(title);
    const text = plain(notice?.content);
    const listedEnd = calendarTime(item.end_time);
    const advertised = detailInterval(text, versions);
    if (kind.startsWith("abyss-") && !advertised) continue;
    const warp = kind === "character" || kind === "weapon" ? warpInterval(text, listedEnd, versions) : undefined;
    const start = advertised?.start ?? warp?.start ?? calendarTime(item.start_time);
    const end = advertised?.end ?? warp?.end ?? listedEnd;
    if (start === undefined || end === undefined || end <= start) continue;
    rows.set(key, {
      title, kind, start, end, permanent: advertised?.permanent, earliestEnd: advertised ? undefined : warp?.earliestEnd,
      banner: officialCalendarImage(item.banner) ?? officialCalendarImage(item.img) ?? officialCalendarImage(notice?.img),
      icon: officialCalendarImage(item.tag_icon),
    });
  }
  return { rows: [...rows.values()], updated, detailsAvailable };
}

const order: Record<CalendarKind, number> = {
  "abyss-1": 0, "abyss-2": 0, "abyss-3": 0, "abyss-4": 0, character: 1, weapon: 2, pass: 5, activity: 5,
};

export function calendarWindow(data: ReturnType<typeof snapshot>, now: number, stale = false): CalendarData {
  const start = Math.floor((now + china) / day) * day - china - 6 * day;
  const end = start + 13 * day;
  const rows = data.rows.filter((row) => row.start < end && row.end > start)
    .sort((a, b) => order[a.kind] - order[b.kind] || a.start - b.start || a.end - b.end).slice(0, 60);
  return { ...data, rows, start, end, now, stale };
}

export function buildStarrailCalendar(list: unknown, content: unknown, now: number): CalendarData {
  return calendarWindow(snapshot(list, content, now), now);
}

async function readJson(response: Response) {
  if (!response.ok || !response.body) throw new Error("无法访问星铁官方公告。");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 4 * 1024 * 1024) throw new Error("星铁公告响应超限。");
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createStarrailCalendarSource(options: {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
} = {}) {
  const transport = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let retained: ReturnType<typeof snapshot> | undefined;
  let active: Promise<ReturnType<typeof snapshot>> | undefined;
  function request(url: string) {
    const timeout = AbortSignal.timeout(12_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    return transport(url, { signal, redirect: "error", credentials: "omit" }).then(readJson);
  }
  return async () => {
    const time = now();
    if (retained && time - retained.updated < (retained.detailsAvailable ? 600_000 : 60_000)) {
      return calendarWindow(retained, time);
    }
    active ??= Promise.all([request(calendarListUrl), request(calendarContentUrl).catch(() => undefined)])
      .then(([list, detail]) => retained = snapshot(list, detail, now())).finally(() => { active = undefined; });
    try {
      return calendarWindow(await active, now());
    } catch (error) {
      if (retained && time - retained.updated < 6 * 3_600_000) return calendarWindow(retained, time, true);
      throw error;
    }
  };
}
