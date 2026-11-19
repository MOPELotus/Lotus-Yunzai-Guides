// Layout and colors adapted from Miao-Plugin resources/wiki/calendar.html and calendar.css (MIT).
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { renderPng } from "@lotus-yunzai/skia";
import { FontLibrary, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { readGuideImage } from "./role-image-files.ts";
import { officialCalendarImage, type CalendarData, type CalendarKind, type CalendarRow } from "./starrail-calendar-data.ts";

const day = 86_400_000;
const china = 8 * 3_600_000;
const scale = 1.1;
const weekdays = "日一二三四五六";
const fontName = "LotusCalendarMiao";
const numberFont = "LotusCalendarNumbers";
const loadedFonts = new Set<string>();
const challengeTheme: Partial<Record<CalendarKind, { color: string; image: string }>> = {
  "abyss-1": { color: "#0f0829", image: "abyss-1.jpg" },
  "abyss-2": { color: "#16202a", image: "abyss-2.jpg" },
  "abyss-3": { color: "#0f0829", image: "abyss-1.jpg" },
  "abyss-4": { color: "#16202a", image: "abyss-4.jpg" },
};

function time(value: number, year = false) {
  return new Date(value + china).toISOString().slice(year ? 0 : 5, 16).replace("T", " ");
}

function relative(milliseconds: number) {
  if (milliseconds >= day) return `${Math.floor(milliseconds / day)}天`;
  if (milliseconds >= 3_600_000) return `${Math.floor(milliseconds / 3_600_000)}小时`;
  return `${Math.max(1, Math.floor(milliseconds / 60_000))}分钟`;
}

function label(row: CalendarRow, now: number, showStart: boolean) {
  if (row.permanent) return row.start <= now ? `${time(row.start)} 后永久有效` : "永久开放";
  if (row.end - row.start > 365 * day) return "结束时间以活动公告为准";
  if (row.earliestEnd !== undefined) return `分批结束：${time(row.earliestEnd)} 至 ${time(row.end)}`;
  if (row.start > now) return `${time(row.start)}（${relative(row.start - now)}后开始）`;
  if (row.end > now) return `${showStart ? time(row.start) + " ~ " : ""}${time(row.end)}（${relative(row.end - now)}后结束）`;
  return `${time(row.start)} ~ ${time(row.end)}`;
}

async function themeImage(root: string | undefined, path: string) {
  if (!root) return;
  const bytes = await readGuideImage(root, path);
  return bytes ? loadImage(bytes).catch(() => undefined) : undefined;
}

async function webImage(url: string, transport: typeof fetch, signal?: AbortSignal) {
  if (!officialCalendarImage(url)) return;
  try {
    const deadline = AbortSignal.timeout(5_000);
    const response = await transport(url, {
      redirect: "error", credentials: "omit", signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (!response.ok || !response.body) return;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 4 * 1024 * 1024) return;
        chunks.push(chunk.value);
      }
      return await loadImage(Buffer.concat(chunks));
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch {}
}

function cover(c: Context, image: Image, x: number, y: number, w: number, h: number) {
  const zoom = Math.max(w / image.width, h / image.height);
  const sw = w / zoom;
  const sh = h / zoom;
  c.drawImage(image, (image.width - sw) / 2, (image.height - sh) * 0.4, sw, sh, x, y, w, h);
}

function font(size: number, family: string) {
  return `${size}px "${numberFont}", "${family}", "Noto Sans CJK SC"`;
}

function text(c: Context, value: string, x: number, y: number, size: number, color: string, family: string,
  align: "left" | "center" = "left", width?: number) {
  c.font = font(size, family);
  c.fillStyle = color;
  c.textAlign = align;
  if (width !== undefined && c.measureText(value).width > width) {
    const chars = [...value];
    while (chars.length && c.measureText(chars.join("") + "…").width > width) chars.pop();
    value = chars.join("") + "…";
  }
  c.fillText(value, x, y);
}

function packedRows(rows: readonly CalendarRow[], timeline: boolean) {
  const lines: CalendarRow[][] = [];
  const used = new Set<CalendarRow>();
  for (const row of rows) {
    if (used.has(row)) continue;
    const partner = timeline && row.kind === "activity"
      ? rows.find((item) => !used.has(item) && item.kind === "activity" && row.end <= item.start)
      : undefined;
    if (partner) used.add(partner);
    lines.push(partner ? [row, partner] : [row]);
  }
  return lines;
}

export async function renderStarrailCalendar(data: CalendarData, mode: "calendar" | "list", options: {
  readonly themeDirectory?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
} = {}) {
  const timeline = mode === "calendar";
  const width = timeline ? 996 : 740;
  const panel = width - 40;
  const rows = packedRows(data.rows, timeline);
  const header = timeline ? 80 : 40;
  const panelHeight = Math.max(400, header + rows.length * 76 + 15);
  const height = panelHeight + 103;
  const source = options.themeDirectory && await realpath(options.themeDirectory).catch(() => undefined);
  let family = "Noto Sans CJK SC";
  if (source) {
    for (const [name, file] of [[fontName, "HYWH-65W.ttf"], [numberFont, "tttgbnumber.ttf"]] as const) {
      const path = await realpath(join(source, "common/font", file)).catch(() => undefined);
      if (!path) continue;
      try {
        if (!loadedFonts.has(path)) {
          FontLibrary.use(name, [path]);
          loadedFonts.add(path);
        }
        if (name === fontName) family = fontName;
      } catch {}
    }
  }
  const urls = [...new Set(data.rows.flatMap(({ banner, icon }) => [banner, icon]).filter((item): item is string => !!item))];
  const transport = options.fetch ?? fetch;
  const [background, icon, challenges, remote] = await Promise.all([
    themeImage(source, "common/bg/bg-sr.webp"), themeImage(source, "wiki/imgs/calendar-icon.png"),
    Promise.all(Object.values(challengeTheme).map(async ({ image }) => [image, await themeImage(source, "wiki/imgs/" + image)] as const)),
    Promise.all(urls.map(async (url) => [url, await webImage(url, transport, options.signal)] as const)),
  ]);
  const media = new Map(remote);
  const local = new Map(challenges);
  return renderPng(Math.ceil(width * scale), Math.ceil(height * scale), (c) => {
    c.scale(scale, scale);
    c.fillStyle = "#181a31";
    c.fillRect(0, 0, width, height);
    if (background) c.drawImage(background, 0, 0, width, height);
    c.fillStyle = "#0009";
    c.beginPath();
    c.roundRect(10, 20, panel + 20, panelHeight + 20, 15);
    c.fill();
    c.fillStyle = "#0007";
    c.fillRect(20, 30, panel, panelHeight);
    c.fillStyle = "#000c";
    c.fillRect(20, 30, panel, header);
    c.strokeStyle = "#ffffff39";
    c.lineWidth = 1;
    c.strokeRect(20.5, 30.5, panel - 1, panelHeight - 1);
    if (timeline) {
      const column = panel / 13;
      const current = Math.floor((data.now - data.start) / day);
      for (let i = 0; i < 13; i++) {
        const cell = new Date(data.start + i * day + china);
        const x = 20 + i * column;
        if (i === current) {
          c.fillStyle = "#d3bc8e";
          c.fillRect(x, 70, column, 40);
          c.fillStyle = "#d3bc8e66";
          c.fillRect(x, 110, column, panelHeight - 80);
        }
        if (i === 0 || cell.getUTCDate() === 1) {
          const last = new Date(Date.UTC(cell.getUTCFullYear(), cell.getUTCMonth() + 1, 0)).getUTCDate();
          const span = Math.min(13 - i, last - cell.getUTCDate() + 1);
          text(c, `${cell.getUTCMonth() + 1}月`, x + column * span / 2, 57, 18, "#d3bc8d", family, "center");
        }
        text(c, `${cell.getUTCDate()}日`, x + column / 2, 89, 16, i === current ? "#141414" : "#fff", family, "center");
        text(c, `周${weekdays[cell.getUTCDay()]}`, x + column / 2, 104, 11, i === current ? "#141414" : "#aaa", family, "center");
        c.fillStyle = "#ffffff44";
        c.fillRect(x, 70, 1, panelHeight - 40);
      }
    } else {
      text(c, "活动列表", width / 2, 57, 19, "#d3bc8d", family, "center");
    }
    const nowX = 20 + (data.now - data.start) / (13 * day) * panel;
    if (timeline) {
      c.fillStyle = "#ffffffe0";
      c.fillRect(nowX, 110, 2, panelHeight - 64);
    }
    if (!rows.length) text(c, "这段时间暂无公开活动", width / 2, 255, 21, "#eee", family, "center");
    for (const [i, line] of rows.entries()) for (const row of line) {
      const start = timeline ? Math.max(0, (row.start - data.start) / (13 * day)) : 0;
      const end = timeline ? Math.min(1, (row.end - data.start) / (13 * day)) : 1;
      const x = 20 + start * panel + 8;
      const y = 30 + header + 14 + i * 76;
      const w = Math.max(4, (end - start) * panel - 16);
      const theme = challengeTheme[row.kind];
      c.save();
      c.beginPath();
      c.roundRect(x, y, w, 62, theme ? 1 : 5);
      c.clip();
      c.fillStyle = theme?.color ?? "#e8e2d8";
      c.fillRect(x, y, w, 62);
      const banner = (row.banner && media.get(row.banner)) || (theme && local.get(theme.image));
      const badge = (row.icon && media.get(row.icon)) || icon;
      const padding = badge && w >= 115 ? 54 : 8;
      const summary = label(row, data.now, w > 365);
      const textWidth = Math.max(0, (banner ? w * 0.76 : w) - padding - 8);
      if (banner && w >= 60) {
        const bw = Math.min(Math.round(w * 0.6), 500);
        const bx = x + w - bw;
        cover(c, banner, bx, y, bw, 62);
        c.font = font(16, family);
        const titleWidth = c.measureText(row.title).width;
        c.font = font(12, family);
        const labelWidth = c.measureText(summary).width;
        const opaque = Math.max(bx, x + padding + Math.min(textWidth, Math.max(titleWidth, labelWidth)) + 6);
        const gradient = c.createLinearGradient(opaque, 0, Math.min(x + w, opaque + 65), 0);
        gradient.addColorStop(0, theme?.color ?? "#e8e2d8");
        gradient.addColorStop(1, "#0000");
        c.fillStyle = gradient;
        c.fillRect(bx, y, bw, 62);
      }
      if (badge && w >= 115) c.drawImage(badge, x + 9, y + 11, 38, 38);
      const color = theme ? "#d3bc8d" : "#25272b";
      text(c, row.title, x + padding, y + 27, 16, color, family, "left", textWidth);
      text(c, summary, x + padding, y + 46, 12, color, family, "left", textWidth);
      if (w > 16) {
        c.lineWidth = 1;
        c.strokeStyle = "#ffffff8e";
        c.beginPath();
        c.roundRect(x + 2.5, y + 2.5, w - 5, 57, 4);
        c.stroke();
      }
      c.restore();
    }
    let foot = `当前时间：${time(data.now, true)}`;
    if (data.stale) foot += ` · 上次公告：${time(data.updated, true)}`;
    if (!data.detailsAvailable) foot += " · 公告详情暂不可用";
    c.fillStyle = "#0009";
    c.beginPath();
    c.roundRect(width / 2 - 280, height - 48, 560, 34, 18);
    c.fill();
    text(c, foot, width / 2, height - 25, 16, "#fff", family, "center");
  }, "gpu");
}
