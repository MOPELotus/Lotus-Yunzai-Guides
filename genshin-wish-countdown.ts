import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
import type { CommandReply } from "../../lib/commands.ts";
import { calendarTransport, officialCalendarImage, readCalendarBytes, type CalendarData } from "./calendar-data.ts";
import { isGuideImage } from "./role-image-files.ts";

const command = /^(?:#|＃)*(?:原神)?卡池(?:剩余|剩下)?时间$/u;
const unavailable = $t("genshin-wish-countdown.text_74f54f95a5");
const day = 86_400_000;
const chinaOffset = 28_800_000;

export const matchesGenshinWishCountdown = (message: string) => command.test(message.trim());

function date(time: number, withTime = false) {
  return new Date(time + chinaOffset).toISOString().slice(0, withTime ? 16 : 10).replace("T", " ");
}

export async function genshinWishCountdown(source: () => Promise<CalendarData>, {
  fetch: request = fetch, signal, now = Date.now,
}: { readonly fetch?: typeof fetch; readonly signal?: AbortSignal; readonly now?: () => number } = {}): Promise<CommandReply> {
  if (signal?.aborted) return [];
  const calendar = await source().catch(() => undefined);
  if (signal?.aborted) return [];
  if (!calendar?.detailsAvailable || calendar.stale) return unavailable;
  const time = now();
  const active = calendar.rows.flatMap(row => row.wishDeadline !== undefined && row.start <= time && time < row.wishDeadline
    ? [{ ...row, deadline: row.wishDeadline }] : []);
  if (!active.length || active.length > 8) return unavailable;
  const transport = calendarTransport(request, signal);
  const artwork = await Promise.all(active.map(async item => {
    const url = officialCalendarImage(item.banner);
    if (!url) return;
    try {
      const file = await readCalendarBytes(await transport(url), 2 * 1024 * 1024);
      if (isGuideImage(file)) return { type: "image" as const, file };
    } catch {}
  }));
  if (signal?.aborted) return [];
  const completed = now();
  if (active.some(row => completed < row.start || completed >= row.deadline)) return $t("genshin-wish-countdown.text_27432ad48a");
  const periods = new Map<string, { start: number; end: number; deadline: number; indices: number[] }>();
  for (const [index, { start, end, deadline }] of active.entries()) {
    const key = `${start}/${deadline}`;
    const period = periods.get(key);
    if (period) period.indices.push(index);
    else periods.set(key, { start, end, deadline, indices: [index] });
  }
  return [$t("genshin-wish-countdown.text_41c687c05b"), ...[...periods.values()].flatMap(({ start, end, deadline, indices }) => [
    `\n${date(start)} ~ ${date(end, true)}\n`,
    ...indices.flatMap(index => [`${active[index]!.title}\n`, ...(artwork[index] ? [artwork[index]!] : [])]),
    $t("genshin-wish-countdown.text_c4a7d5858b", { "value1": Math.ceil((deadline - completed) / day) }),
  ])];
}
