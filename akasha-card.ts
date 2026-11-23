import { renderPng } from "@lotus-yunzai/skia";
import { loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";

type Caption = { readonly lead: string; readonly label: string; readonly meta: string; readonly history?: string };

export type AkashaCard = Caption & (
  | { readonly type: "usage"; readonly characters: readonly { readonly name: string; readonly rarity: number; readonly rate: number }[] }
  | { readonly type: "teams"; readonly page: number; readonly pageCount: number; readonly teams: readonly {
    readonly names: readonly string[]; readonly count: number; readonly full: number; readonly ratio: string;
  }[] }
);

type ReadImage = (path: string, fixed: boolean) => Promise<Buffer | undefined>;
const serif = '"Source Han Serif SC","Noto Serif CJK SC","Noto Sans CJK SC",sans-serif';
const usageSeparators = ["split100", "split75", "split50", "split10"];
const limits = [60, 25, 6, 0];

function label(context: Context, text: string, x: number, y: number, size: number,
  { color = "#f5f6f7", align = "left", maxWidth }: {
    color?: string; align?: CanvasTextAlign; maxWidth?: number;
  } = {}) {
  context.fillStyle = color;
  context.font = `800 ${size}px ${serif}`;
  context.textAlign = align;
  if (maxWidth) context.fillText(text, x, y, maxWidth);
  else context.fillText(text, x, y);
}

function cover(context: Context, image: Image, x: number, y: number, width: number, height: number) {
  const ratio = Math.max(width / image.width, height / image.height);
  context.save();
  context.beginPath();
  context.rect(x, y, width, height);
  context.clip();
  context.drawImage(image, x + (width - image.width * ratio) / 2, y + (height - image.height * ratio) / 2,
    image.width * ratio, image.height * ratio);
  context.restore();
}

export async function drawAkashaCard(card: AkashaCard, readImage: ReadImage, mode: "auto" | "gpu" = "auto") {
  async function read(path: string, fixed: boolean) {
    const bytes = await readImage(path, fixed);
    if (bytes) return loadImage(bytes).catch(() => undefined);
  }
  const names = new Set(card.type === "usage" ? card.characters.map(row => row.name) : card.teams.flatMap(row => row.names));
  const [background, separators, portraitEntries] = await Promise.all([
    read(`img/background/${card.type === "usage" ? "AbyssUR_bg" : "AbyssTeams_bg"}.webp`, true),
    Promise.all((card.type === "usage" ? usageSeparators : ["team_split"])
      .map(name => read(`img/separator/${name}.png`, true))),
    Promise.all([...names].map(async name => [name, await read(`img/role/${name}.png`, false)] as const)),
  ]);
  const portraits = new Map(portraitEntries);
  const width = card.type === "usage" ? 2667 : 1500;
  const height = card.type === "usage" ? 1500 : 2667;
  return renderPng(width, height, context => {
    context.fillStyle = "#243449";
    context.fillRect(0, 0, width, height);
    if (background) cover(context, background, 0, 0, width, height);
    context.fillStyle = "#10162544";
    context.fillRect(0, 0, width, height);

    label(context, "Lotus-Yunzai · @容容容三岁 设计", width - 56, 86, 31, { align: "right", color: "#f6e5cc" });
    label(context, card.meta, width - 56, 135, 32, { align: "right" });
    if (card.history) label(context, card.history, width - 56, 181, 36, { align: "right", color: "#ffda96" });

    if (card.type === "usage") {
      label(context, card.lead, width - 56, 324, 83, { align: "right", maxWidth: 780 });
      label(context, card.label, width - 56, 423, 87, { align: "right", maxWidth: 780 });
      const groups = limits.map((limit, index) => card.characters.filter(row =>
        row.rate >= limit && (index === 0 || row.rate < limits[index - 1]!)));
      const columns = [12, 13, 13, 20];
      const groupHeight = groups.map((group, index) => 72 + Math.ceil(group.length / columns[index]!) * 100);
      const compression = Math.min(1, (height - 95) / groupHeight.reduce((total, row) => total + row, 0));
      let y = 50;
      for (const [index, group] of groups.entries()) {
        const separator = separators[index];
        if (separator) context.drawImage(separator, 65, y, Math.min(separator.width, 1560), 35);
        label(context, index === 3 ? "低于 6%" : `${limits[index]}%+`, 315, y + 34, 32, { color: "#ffdfac" });
        y += 52 * compression;
        for (const [position, character] of group.entries()) {
          const x = 70 + (position % columns[index]!) * 123;
          const top = y + Math.floor(position / columns[index]!) * 100 * compression;
          const portrait = portraits.get(character.name);
          context.fillStyle = character.rarity === 5 ? "#b8723bc9" : "#80578bc9";
          context.fillRect(x, top, 110, 86 * compression);
          if (portrait) cover(context, portrait, x, top, 51, 86 * compression);
          label(context, character.rate.toFixed(1) + "%", x + 106, top + 40 * compression, 19,
            { align: "right" });
          label(context, character.name, x + 106, top + 75 * compression, 22, { align: "right", maxWidth: 104 });
        }
        y += (20 + Math.ceil(group.length / columns[index]!) * 100) * compression;
      }
      return;
    }

    label(context, card.lead, width - 56, 313, 95, { align: "right", maxWidth: 1388 });
    label(context, card.label, width - 56, 420, 90, { align: "right", maxWidth: 1388 });
    for (const [index, team] of card.teams.entries()) {
      const left = 56 + (index % 2) * 722;
      const top = 479 + Math.floor(index / 2) * 289;
      if (separators[0]) context.drawImage(separators[0]!, left, top, 648, 27);
      label(context, String(index + 1), left, top + 102, 44, { color: "#ffdda5" });
      for (const [position, name] of team.names.entries()) {
        const x = left + 61 + position * 145;
        const portrait = portraits.get(name);
        if (portrait) cover(context, portrait, x, top + 35, 129, 112);
        label(context, name, x + 64, top + 177, 27, { align: "center", maxWidth: 127 });
      }
      const metrics = [["出战数", String(team.count)], ["满星率", team.full.toFixed(2) + "%"], ["上下比", team.ratio]];
      for (const [index, [name, value]] of metrics.entries()) {
        const x = left + 150 + index * 204;
        label(context, value!, x, top + 219, 38, { align: "center" });
        label(context, name!, x, top + 251, 26, { align: "center", color: "#f6e5cc" });
      }
    }
    label(context, `第 ${card.page}/${card.pageCount} 页 · 虚空深渊队伍 1–7`, width / 2, height - 65, 43, { align: "center" });
  }, mode, { allowHalfScale: true });
}
