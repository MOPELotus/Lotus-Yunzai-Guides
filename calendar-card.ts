import { prepareBuiltinFonts, builtinFontFallback } from "../../packages/skia/builtin-fonts.ts";
// Layout and colors adapted from Miao-Plugin resources/wiki/calendar.html and calendar.css (MIT).
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { ImageSizeLimitError, nativeImageRasterScale, renderPng } from "@lotus-yunzai/skia";
import { FontLibrary, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { readGuideImage } from "./role-image-files.ts";
import { officialCalendarImage, type CalendarGame, type CalendarData, type CalendarKind, type CalendarRow } from "./calendar-data.ts";
import { genshinCalendarExtras, genshinCalendarMaterial, genshinCalendarPortrait } from "./genshin-calendar-theme.ts";

const day = 86_400_000;
const china = 8 * 3_600_000;
const weekdays = "日一二三四五六";
const fontName = "LotusCalendarText";
const numberFont = "LotusCalendarNumbers";
const loadedFonts = new Set<string>();
const challengeTheme: Partial<Record<CalendarKind, { color: string; image: string }>> = {
  abyss: { color: "#333465", image: "abyss.jpg" },
  newAbyss: { color: "#1a3061", image: "newAbyss.jpg" },
  "abyss-1": { color: "#0f0829", image: "abyss-1.jpg" },
  "abyss-2": { color: "#16202a", image: "abyss-2.jpg" },
  "abyss-3": { color: "#0f0829", image: "abyss-1.jpg" },
  "abyss-4": { color: "#16202a", image: "abyss-4.jpg" },
};

function time(value: number, year = false) {
  return new Date(value + china).toISOString().slice(year ? 0 : 5, 16).replace("T", " ");
}

function relative(milliseconds: number) {
  if (milliseconds >= day) return `${Math.round(milliseconds / day)}天`;
  if (milliseconds >= 3_600_000) return `${Math.floor(milliseconds / 3_600_000)}小时`;
  return `${Math.max(1, Math.floor(milliseconds / 60_000))}分钟`;
}

function label(row: CalendarRow, now: number, showStart: boolean) {
  if (row.permanent) return row.start <= now ? `${time(row.start)} 后永久有效` : "永久开放";
  if (row.startUnverified) return `截止：${time(row.end)}`;
  if (row.end - row.start > 365 * day) return "结束时间以活动公告为准";
  if (row.earliestEnd !== undefined) return `分批结束：${time(row.earliestEnd)} 至 ${time(row.end)}`;
  const crossesYear = new Date(row.start + china).getUTCFullYear() !== new Date(row.end + china).getUTCFullYear();
  const start = time(row.start, crossesYear);
  const end = time(row.end, crossesYear);
  if (row.monthlyRotation) return `按月轮换 · ${showStart ? start + " ~ " : ""}${end}`;
  if (row.start > now) return `${start}（${relative(row.start - now)}后开始）`;
  if (row.end > now) return `${showStart ? start + " ~ " : ""}${end}（${relative(row.end - now)}后结束）`;
  return `${start} ~ ${end}`;
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
  return `${size}px "${numberFont}", "${family}", ${builtinFontFallback}`;
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

function packedRows(rows: readonly CalendarRow[], timeline: boolean, genshin: boolean) {
  const lines: CalendarRow[][] = [];
  const used = new Set<CalendarRow>();
  for (const row of rows) {
    if (used.has(row)) continue;
    const mergeable = row.kind === "activity" || row.kind === "normal" ||
      (genshin && (row.kind === "character" || row.kind === "weapon"));
    const partner = timeline && mergeable
      ? rows.find((item) => !used.has(item) && item.kind === row.kind && row.end <= item.start)
      : undefined;
    if (partner) used.add(partner);
    lines.push(partner ? [row, partner] : [row]);
  }
  return lines;
}

export async function renderCalendar(data: CalendarData, mode: "calendar" | "list", options: {
  readonly game: CalendarGame;
  readonly themeDirectory?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly inlineImageByteLimit?: number;
}) {
  prepareBuiltinFonts();
  options.signal?.throwIfAborted();
  const timeline = mode === "calendar";
  const width = timeline ? 996 : 740;
  const panel = width - 40;
  const gs = options.game === "genshin";
  const hydro = options.game !== "starrail";
  const rows = packedRows(data.rows, timeline, gs);
  const source = options.themeDirectory && await realpath(options.themeDirectory).catch(() => undefined);
  const extras = gs && source ? await genshinCalendarExtras(source, data.start, data.now) : undefined;
  const births = timeline ? extras?.birthdays ?? [] : [];
  const birthdays = 74 * Math.max(0, ...births.map((entries) => entries.length));
  const headerHeight = timeline ? 80 : 40;
  const header = headerHeight + birthdays;
  const rowPositions: number[] = [];
  let heightOfRows = 0;
  for (const line of rows) {
    rowPositions.push(heightOfRows);
    heightOfRows += line.every((row) => row.kind === "normal") ? 48 : 76;
  }
  const panelHeight = Math.max(400, header + heightOfRows + 15);
  const footer = panelHeight + 103;
  const talentCards = extras?.materials.flatMap(({ name, region, roles, item, color }) =>
    roles.map((role, index) => ({ role, title: index === 0 ? `${region}·${name}` : undefined, item, color, groupSize: roles.length }))) ?? [];
  const talentsPerRow = Math.floor((width - 30) / 87);
  const height = footer + (talentCards.length ? Math.ceil(talentCards.length / talentsPerRow) * 109 + 16 : 0);
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
  const characterFiles = [
    ...births.flat().map((role) => genshinCalendarPortrait(role.name, "face")),
    ...data.rows.flatMap(({ character }) => character ? [genshinCalendarPortrait(character, "face"), genshinCalendarPortrait(character, "card")] : []),
    ...talentCards.flatMap(({ role, item, title }) => [
      genshinCalendarPortrait(role.name, "face"), title ? genshinCalendarMaterial(item, "talent") : undefined,
      role.weekly ? genshinCalendarMaterial(role.weekly, "weekly") : undefined,
    ]),
  ].filter((item): item is string => !!item);
  const [background, icon, challenges, remote, genshin] = await Promise.all([
    themeImage(source, hydro ? "common/bg/bg-hydro.webp" : "common/bg/bg-sr.webp"), themeImage(source, "wiki/imgs/calendar-icon.png"),
    Promise.all(Object.entries(challengeTheme).map(async ([kind, theme]) => [kind, await Promise.all([
      themeImage(source, "wiki/imgs/" + theme.image), themeImage(source, `wiki/imgs/${kind}-icon.png`),
    ])] as const)),
    Promise.all(urls.map(async (url) => [url, await webImage(url, transport, options.signal)] as const)),
    Promise.all([...new Set(characterFiles)].map(async (path) => [path, await themeImage(source, path)] as const)),
  ]);
  const media = new Map(remote);
  const local = new Map(challenges);
  const things = new Map(genshin);
  const portrait = (name: string | undefined, type: "face" | "card") => name ? things.get(genshinCalendarPortrait(name, type) ?? "") : undefined;
  const localMaterial = (name: string, type: "talent" | "weekly") => things.get(genshinCalendarMaterial(name, type) ?? "");
  const draw = (c: Context) => {
    c.fillStyle = hydro ? "#16243c" : "#181a31";
    c.fillRect(0, 0, width, height);
    if (background) c.drawImage(background, 0, 0, width, height);
    c.fillStyle = "#0009";
    c.beginPath();
    c.roundRect(10, 20, panel + 20, panelHeight + 20, 15);
    c.fill();
    c.fillStyle = "#0007";
    c.fillRect(20, 30, panel, panelHeight);
    c.fillStyle = "#000c";
    c.fillRect(20, 30, panel, headerHeight);
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
        for (const [index, role] of (births[i] ?? []).entries()) {
          const image = portrait(role.name, "face");
          const y = 115 + index * 74;
          c.fillStyle = role.star === 5 ? "#9c6b44" : "#645088";
          c.fillRect(x + 7, y, column - 14, 64);
          if (image) cover(c, image, x + 7, y, column - 14, 49);
          c.fillStyle = "#e8e2d8";
          c.fillRect(x + 7, y + 49, column - 14, 15);
          text(c, role.short.length >= 4 ? role.short : role.short + "生日", x + column / 2, y + 61, 10, "#25272b", family, "center", column - 18);
        }
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
      const y = 30 + header + 14 + (rowPositions[i] ?? 0);
      const w = Math.max(4, (end - start) * panel - 16);
      const theme = challengeTheme[row.kind];
      const small = row.kind === "normal";
      const h = small ? 37 : 62;
      const narrow = timeline && w < 220;
      c.save();
      c.beginPath();
      c.roundRect(x, y, w, h, theme ? 1 : 5);
      c.clip();
      c.fillStyle = theme?.color ?? "#e8e2d8";
      c.fillRect(x, y, w, h);
      const [challengeBanner, challengeIcon] = local.get(row.kind) ?? [];
      const banner = portrait(row.character, "card") || (row.banner && media.get(row.banner)) || challengeBanner;
      const face = portrait(row.character, "face");
      const badge = face || (row.icon && media.get(row.icon)) || challengeIcon || icon;
      const padding = badge && w >= 115 ? small ? 37 : narrow ? 40 : 54 : 8;
      const heading = narrow ? row.character ?? /^「([^」]+)」/u.exec(row.title)?.[1] ?? row.title : row.title;
      const summary = narrow && !row.startUnverified && data.now < row.start
        ? `${row.monthlyRotation ? "按月轮换 · " : ""}${time(row.start)}` : label(row, data.now, w > 365);
      const textWidth = Math.max(0, (banner && !narrow ? w * 0.76 : w) - padding - 8);
      if (banner && w >= 60) {
        const bw = Math.min(Math.round(w * 0.6), 500);
        const bx = x + w - bw;
        cover(c, banner, bx, y, bw, h);
        c.font = font(16, family);
        const titleWidth = c.measureText(heading).width;
        c.font = font(12, family);
        const labelWidth = c.measureText(summary).width;
        const opaque = Math.max(bx, x + padding + Math.min(textWidth, Math.max(titleWidth, labelWidth)) + 6);
        const gradient = c.createLinearGradient(opaque, 0, Math.min(x + w, opaque + 65), 0);
        gradient.addColorStop(0, theme?.color ?? "#e8e2d8");
        gradient.addColorStop(1, "#0000");
        c.fillStyle = gradient;
        c.fillRect(bx, y, bw, h);
      }
      if (badge && w >= 115) {
        const edge = small ? 22 : narrow ? 30 : face ? 51 : 38;
        c.drawImage(badge, x + (face ? 0 : 9), y + (h - edge) / 2, edge, edge);
      }
      const color = theme ? "#d3bc8d" : "#25272b";
      text(c, heading, x + padding, y + (small ? 15 : 27), small ? 13 : 16, color, family, "left", textWidth);
      text(c, summary, x + padding, y + (small ? 31 : 46), small ? 10 : 12, color, family, "left", textWidth);
      if (w > 16) {
        c.lineWidth = 1;
        c.strokeStyle = "#ffffff8e";
        c.beginPath();
        c.roundRect(x + 2.5, y + 2.5, w - 5, h - 5, 4);
        c.stroke();
      }
      c.restore();
    }
    let foot = `当前时间：${time(data.now, true)}`;
    if (data.stale) foot += ` · 上次公告：${time(data.updated, true)}`;
    if (!data.detailsAvailable) foot += " · 公告详情暂不可用";
    c.fillStyle = "#0009";
    c.beginPath();
    c.roundRect(width / 2 - 280, footer - 48, 560, 34, 18);
    c.fill();
    text(c, foot, width / 2, footer - 25, 16, "#fff", family, "center");
    if (talentCards.length) {
      c.fillStyle = "#0009";
      c.fillRect(10, footer, width - 20, height - footer - 8);
      for (const [index, { role, title, item, color, groupSize }] of talentCards.entries()) {
        const x = 16 + (index % talentsPerRow) * 87;
        const y = footer + 6 + Math.floor(index / talentsPerRow) * 109;
        const image = portrait(role.name, "face");
        c.fillStyle = color;
        c.fillRect(x + 2, y + 18, 84, 4);
        c.fillStyle = role.star === 5 ? "#9c6b44" : "#645088";
        c.fillRect(x + 5, y + 23, 77, 78);
        if (image) cover(c, image, x + 5, y + 23, 77, 70);
        text(c, role.short, x + 43, y + 99, 10, "#fff", family, "center", 69);
        const weekly = role.weekly && localMaterial(role.weekly, "weekly");
        if (weekly) c.drawImage(weekly, x + 59, y + 77, 23, 23);
        if (title) {
          const material = localMaterial(item, "talent");
          if (material) c.drawImage(material, x, y - 2, 31, 31);
          const labelX = x + (material ? 29 : 1);
          text(c, title, labelX, y + 14, 12, "#fff", family, "left", Math.min(groupSize > 1 ? 120 : 78, width - labelX - 6));
        }
      }
    }
  };
  const render = (scale: 2 | 4) => {
    options.signal?.throwIfAborted();
    return renderPng(Math.ceil(width * scale), Math.ceil(height * scale), c => {
      c.scale(scale, scale);
      draw(c);
    }, "gpu", { allowHalfScale: scale === 4, renderScale: scale });
  };
  const limit = options.inlineImageByteLimit ?? Infinity;
  const standard = nativeImageRasterScale() === 4;
  const full = await render(4);
  if (full.png.byteLength <= limit) return full;
  if (standard && !full.reducedScaleReason) {
    const half = await render(2);
    if (half.png.byteLength <= limit) return half;
  }
  throw new ImageSizeLimitError("当前会话的图片大小上限不足以发送完整日历。");
}
