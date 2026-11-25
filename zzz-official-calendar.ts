import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
import type { CommandReply } from "../../lib/commands.ts";
import { calendarTime, calendarTransport, officialCalendarImage, readCalendarBytes, readCalendarJson,
  zzzCalendarContentUrl, zzzCalendarListUrl } from "./calendar-data.ts";
import { isGuideImage, roleImageLimit } from "./role-image-files.ts";

const command = /^(?:[#%％/]?(?:zzz|ZZZ|绝区零)|[%％]|#绝区零(?:zzz|ZZZ))cal$/u;
const minute = 60_000;
const missingCalendar = $t("zzz-official-calendar.text_3d3b06be2c");
const missingImage = $t("zzz-official-calendar.text_0c867c717c");

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function rows(value: unknown) {
  return Array.isArray(value) ? value.map(object) : [];
}

function responseData(value: unknown) {
  const response = object(value);
  const data = object(response.data);
  if (response.retcode === 0 && Array.isArray(data.list)) return data;
}

function officialImage(content: string) {
  const match = /<img\b[^>]*?\s+src\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/iu.exec(content);
  const url = officialCalendarImage(match?.[1] ?? match?.[2]);
  if (!url) return;
  const path = new URL(url);
  if (!path.search && !path.hash && /^\/upload\/ann\/20\d{2}\/\d{2}\/\d{2}\/[\w.-]+\.(?:png|jpe?g|webp)$/iu.test(path.pathname)) return url;
}

type Result =
  | { readonly status: "missing"; readonly reply: string }
  | { readonly status: "failed"; readonly reply: string; readonly url?: string }
  | { readonly status: "image"; readonly reply: { readonly type: "image"; readonly file: Buffer };
      readonly url: string; readonly expiresAt: number };

export function createZzzOfficialCalendar(options: {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
} = {}) {
  const transport = calendarTransport(options.fetch ?? fetch, options.signal);
  const request = (url: string) => transport(url).then(readCalendarJson).then(responseData).catch(() => undefined);
  const now = options.now ?? Date.now;
  let cached: { result: Result; checked: number } | undefined;
  let retained: Extract<Result, { status: "image" }> | undefined;
  let active: Promise<Result> | undefined;

  async function load(): Promise<Result> {
    const list = await request(zzzCalendarListUrl);
    if (!list) return { status: "failed", reply: $t("zzz-official-calendar.text_e56348c422") };
    const timestamp = typeof list.t === "string" || typeof list.t === "number" ? String(list.t) : "";
    const detailUrl = new URL(zzzCalendarContentUrl);
    detailUrl.searchParams.set("t", /^[\w.-]{1,128}$/u.test(timestamp) && timestamp !== "0" ? timestamp : String(now()));
    const detail = await request(detailUrl.href);
    if (!detail) return { status: "failed", reply: $t("zzz-official-calendar.text_8d35469515") };
    const article = rows(detail.list).find(({ title, subtitle }) => typeof title === "string" && title.includes("日历") &&
      typeof subtitle === "string" && subtitle.includes("活动日历"));
    if (typeof article?.content !== "string" || !article.content) return { status: "missing", reply: missingCalendar };
    const published = typeof article.ann_id === "number" ? rows(list.list)
      .flatMap(section => rows(section.list)).find(item => item.ann_id === article.ann_id) : undefined;
    const start = calendarTime(published?.start_time ?? article.start_time);
    const end = calendarTime(published?.end_time ?? article.end_time);
    const time = now();
    if ((start !== undefined && start > time) || (end !== undefined && time >= end)) {
      return { status: "missing", reply: missingCalendar };
    }
    const url = officialImage(article.content);
    if (!url) return { status: "missing", reply: missingImage };
    try {
      const file = await readCalendarBytes(await transport(url), roleImageLimit);
      if (!isGuideImage(file)) throw new Error($t("zzz-official-calendar.text_368d5a68ac"));
      const expiresAt = Math.min(end ?? Infinity, now() + 6 * 60 * minute);
      if (now() >= expiresAt) return { status: "missing", reply: missingCalendar };
      return { status: "image", reply: { type: "image", file }, url, expiresAt };
    } catch {
      return { status: "failed", reply: $t("zzz-official-calendar.text_6d83e69ba0"), url };
    }
  }

  function originalImage(result: Extract<Result, { status: "image" }>, limit: number) {
    if (result.reply.file.byteLength <= limit) return result.reply;
    return $t("zzz-official-calendar.text_3298c8161e", { "url": result.url });
  }

  async function lookup(limit = Infinity): Promise<CommandReply> {
    const time = now();
    if (retained && time >= retained.expiresAt) retained = undefined;
    const ttl = cached?.result.status === "image" ? 10 * minute : minute;
    let result = cached && time - cached.checked < ttl &&
      (cached.result.status !== "image" || time < cached.result.expiresAt) ? cached.result : undefined;
    if (!result) {
      active ??= load().then(result => {
        cached = { result, checked: now() };
        if (result.status === "image") retained = result;
        else if (result.status === "missing" || (result.url && result.url !== retained?.url)) retained = undefined;
        return result;
      }).finally(() => { active = undefined; });
      result = await active;
    }
    if (result.status === "image") return now() < result.expiresAt ? originalImage(result, limit) : missingCalendar;
    if (result.status === "failed" && retained && now() < retained.expiresAt && (!result.url || result.url === retained.url)) {
      return [$t("zzz-official-calendar.text_2d75141731"), originalImage(retained, limit)];
    }
    return result.reply;
  }

  return (message: string, inlineImageByteLimit?: number) => command.test(message.trim()) ? lookup(inlineImageByteLimit) : undefined;
}
