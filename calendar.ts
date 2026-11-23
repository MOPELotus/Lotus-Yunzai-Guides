import { fileURLToPath } from "node:url";
import type { CommandReply } from "../../lib/commands.ts";
import { ImageSizeLimitError } from "@lotus-yunzai/skia";
import { createCalendarSource, type CalendarData, type CalendarGame } from "./calendar-data.ts";
import { createZzzOfficialCalendar } from "./zzz-official-calendar.ts";
import { genshinWishCountdown, matchesGenshinWishCountdown } from "./genshin-wish-countdown.ts";
import type { CalendarScheduleKind } from "./calendar-schedule.ts";

const games = {
  starrail: { label: "星铁", rule: /^#星铁日历(列表)?$/u, theme: "LOTUS_STAR_RAIL_GACHA_THEME_DIR" },
  genshin: { label: "原神", rule: /^#+日历(列表)?$/u, theme: "LOTUS_GENSHIN_GACHA_THEME_DIR" },
  zzz: { label: "绝区零", rule: /^#绝区零日历(列表)?$/u, theme: "LOTUS_ZZZ_CALENDAR_THEME_DIR" },
} as const;

type CalendarOptions = {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly themeDirectory?: string;
};
type CalendarImage = { readonly type: "image"; readonly file: Buffer };
type CalendarReply = CalendarImage | string;

function formatCalendarText(table: CalendarData, label: string, title: string, reason: string) {
  const date = (value: number) => new Date(value + 8 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
  const heading = [`${label}${title} · ${reason}`, ...(table.stale ? ["以下为上次读取的公告。"] : []),
    ...(!table.detailsAvailable ? ["公告详情暂不可用。"] : [])];
  if (!table.rows.length) return [...heading, "当前日期范围暂无活动公告。"].join("\n");
  const lines = table.rows.slice(0, 10).map(({ title, start, end, permanent, monthlyRotation }) =>
    `${title.slice(0, 120)} · ${date(start)}${permanent ? " 起长期有效" : " 至 " + date(end)}${monthlyRotation ? "（按月轮换）" : ""}`);
  if (table.rows.length > lines.length) lines.push(`另有 ${table.rows.length - lines.length} 项活动。`);
  return [...heading, ...lines].join("\n");
}

function createGameCalendar(game: CalendarGame, options: CalendarOptions = {}) {
  const config = games[game];
  const defaultTheme = fileURLToPath(new URL(`../../data/${game === "zzz" ? "genshin" : game}/miao-theme/`, import.meta.url));
  const source = createCalendarSource(game, options);

  async function render(list: boolean, inlineImageByteLimit?: number, signal = options.signal): Promise<CalendarReply | undefined> {
    signal?.throwIfAborted();
    const table = await source().catch(() => undefined);
    signal?.throwIfAborted();
    if (!table) return;
    try {
      const { renderCalendar } = await import("./calendar-card.ts");
      const { png } = await renderCalendar(table, list ? "list" : "calendar", {
        ...options, signal, game, inlineImageByteLimit,
        themeDirectory: options.themeDirectory ?? (Bun.env[config.theme]?.trim() || defaultTheme),
      });
      signal?.throwIfAborted();
      return { type: "image", file: png };
    } catch (error) {
      signal?.throwIfAborted();
      const reason = error instanceof ImageSizeLimitError ? "整图超过当前会话的图片上限" : "暂时无法生成图片";
      return formatCalendarText(table, config.label, list ? "日历列表" : "日历", reason);
    }
  }

  function handle(message: string, inlineImageByteLimit?: number): CommandReply | Promise<CommandReply> | undefined {
    if (game === "genshin" && matchesGenshinWishCountdown(message)) return genshinWishCountdown(source, options);
    const match = config.rule.exec(message.trim());
    if (!match) return;
    return render(Boolean(match[1]), inlineImageByteLimit).then(reply =>
      reply ?? `暂时无法读取${config.label}官方活动公告，请稍后再试。`);
  }
  return { handle, render };
}

export function createScheduledCalendarRenderer(options: CalendarOptions) {
  const genshin = createGameCalendar("genshin", options);
  const starrail = createGameCalendar("starrail", options);
  return async function renderScheduled(type: CalendarScheduleKind, signal: AbortSignal, inlineImageByteLimit?: number) {
    const selected = type === "G" ? [genshin] : type === "S" ? [starrail] : [genshin, starrail];
    const render = (limit = inlineImageByteLimit) => Promise.all(selected.map(calendar => calendar.render(false, limit, signal)));
    let result = await render();
    if (inlineImageByteLimit !== undefined && result.reduce((bytes, reply) =>
      bytes + (typeof reply === "object" ? reply.file.byteLength : 0), 0) > inlineImageByteLimit) {
      result = await render(Math.floor(inlineImageByteLimit / selected.length));
    }
    if (result.every(reply => reply !== undefined)) return result;
  };
}

export const createStarrailCalendar = (options?: CalendarOptions) => createGameCalendar("starrail", options).handle;
export const createGenshinCalendar = (options?: CalendarOptions) => createGameCalendar("genshin", options).handle;
export function createZzzCalendar(options?: CalendarOptions) {
  const official = createZzzOfficialCalendar(options);
  const rendered = createGameCalendar("zzz", options).handle;
  return (message: string, inlineImageByteLimit?: number) =>
    official(message, inlineImageByteLimit) ?? rendered(message, inlineImageByteLimit);
}
