import { fileURLToPath } from "node:url";
import type { CommandReply } from "../../lib/commands.ts";
import { createStarrailCalendarSource } from "./starrail-calendar-data.ts";

const defaultTheme = fileURLToPath(new URL("../../data/starrail/miao-theme/", import.meta.url));

export function createStarrailCalendar(options: {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly themeDirectory?: string;
} = {}) {
  const source = createStarrailCalendarSource(options);
  return (message: string): CommandReply | Promise<CommandReply> | undefined => {
    const match = /^#星铁日历(列表)?$/u.exec(message.trim());
    if (!match) return;
    return (async () => {
      const table = await source().catch(() => undefined);
      if (!table) return "暂时无法读取星铁官方活动公告，请稍后再试。";
      try {
        const { renderStarrailCalendar } = await import("./starrail-calendar-card.ts");
        const { png } = await renderStarrailCalendar(table, match[1] ? "list" : "calendar", {
          ...options,
          themeDirectory: options.themeDirectory ?? (Bun.env.LOTUS_STAR_RAIL_GACHA_THEME_DIR?.trim() || defaultTheme),
        });
        return { type: "image", file: png };
      } catch {
        return "已读取星铁活动公告，暂时无法生成日历图片。";
      }
    })();
  };
}
