import { fileURLToPath } from "node:url";
import type { CommandReply } from "../../lib/commands.ts";
import { createCalendarSource, type CalendarGame } from "./calendar-data.ts";

const games = {
  starrail: { label: "星铁", rule: /^#星铁日历(列表)?$/u, theme: "LOTUS_STAR_RAIL_GACHA_THEME_DIR" },
  genshin: { label: "原神", rule: /^(?:#|喵喵)+日历(列表)?$/u, theme: "LOTUS_GENSHIN_GACHA_THEME_DIR" },
} as const;

function createGameCalendar(game: CalendarGame, options: {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly themeDirectory?: string;
} = {}) {
  const config = games[game];
  const defaultTheme = fileURLToPath(new URL(`../../data/${game}/miao-theme/`, import.meta.url));
  const source = createCalendarSource(game, options);
  return (message: string): CommandReply | Promise<CommandReply> | undefined => {
    const match = config.rule.exec(message.trim());
    if (!match) return;
    return (async () => {
      const table = await source().catch(() => undefined);
      if (!table) return `暂时无法读取${config.label}官方活动公告，请稍后再试。`;
      try {
        const { renderCalendar } = await import("./calendar-card.ts");
        const { png } = await renderCalendar(table, match[1] ? "list" : "calendar", {
          ...options, game,
          themeDirectory: options.themeDirectory ?? (Bun.env[config.theme]?.trim() || defaultTheme),
        });
        return { type: "image", file: png };
      } catch {
        return `已读取${config.label}活动公告，暂时无法生成日历图片。`;
      }
    })();
  };
}

export const createStarrailCalendar = (options?: Parameters<typeof createGameCalendar>[1]) => createGameCalendar("starrail", options);
export const createGenshinCalendar = (options?: Parameters<typeof createGameCalendar>[1]) => createGameCalendar("genshin", options);
