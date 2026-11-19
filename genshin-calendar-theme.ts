// Calendar.getCharData and meta-gs/material/daily.js from Miao-Plugin (MIT).
import { join } from "node:path";
import { readGuideFile } from "./role-image-files.ts";
import { safeGuideName } from "./role-guide-input.ts";

const talents = [
  ["自由", "繁荣", "浮世", "诤言", "公平", "角逐", "月光", "慈爱"],
  ["抗争", "勤劳", "风雅", "巧思", "正义", "焚燔", "乐园", "坚忍"],
  ["诗文", "黄金", "天光", "笃行", "秩序", "纷争", "浪迹", "荣光"],
] as const;
const locations = ["蒙德", "璃月", "稻妻", "须弥", "枫丹", "纳塔", "挪德卡莱", "至冬"];
const regionColors = ["#37c9b8", "#bca244", "#ac60c9", "#54b640", "#557dd6", "#cc3333", "#e6e6fa", "#a5fcfc"];
const china = 8 * 3_600_000;
const day = 86_400_000;
const characterRoot = "meta-gs/character";
const materialRoot = "meta-gs/material";

interface CalendarCharacter {
  readonly id: number;
  readonly name: string;
  readonly star: number;
  readonly short: string;
  readonly birthday: string;
  readonly talent?: string;
  readonly weekly?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function json(root: string, path: string) {
  const bytes = await readGuideFile(root, path, 750 * 1024);
  if (bytes) {
    try { return record(JSON.parse(bytes.toString("utf8"))); } catch {}
  }
  return {};
}

async function originals(root: string, now: number) {
  const data = await json(root, join(characterRoot, "data.json"));
  const entries = Object.entries(data);
  if (entries.length > 300) return [];
  const characters = await Promise.all(entries.map(async ([id, raw]): Promise<CalendarCharacter | undefined> => {
    const { name, abbr, star, eta } = record(raw);
    if (!/^10\d{6}$/u.test(id) || typeof name !== "string" || !safeGuideName(name) ||
        typeof eta !== "number" || eta > now || eta <= 0 || (star !== 4 && star !== 5)) return;
    const details = await json(root, join(characterRoot, name, "data.json"));
    const { talent, weekly } = record(details.materials);
    return {
      id: Number(id), name, star, short: typeof abbr === "string" ? abbr : name,
      birthday: typeof details.birth === "string" ? details.birth : "",
      talent: typeof talent === "string" && safeGuideName(talent) ? talent : undefined,
      weekly: typeof weekly === "string" && safeGuideName(weekly) ? weekly : undefined,
    };
  }));
  return characters.filter((row): row is CalendarCharacter => !!row);
}

export async function genshinCalendarExtras(root: string, start: number, now: number) {
  const characters = await originals(root, now);
  const birthdays = Array.from({ length: 13 }, (_, offset) => {
    const date = new Date(start + offset * day + china);
    const birthday = `${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
    return characters.filter((character) => character.birthday === birthday);
  });
  const weekday = new Date(now + china - 4 * 3_600_000).getUTCDay();
  const families = weekday === 0 ? talents : talents.slice((weekday - 1) % 3, (weekday - 1) % 3 + 1);
  const materials = families.flatMap((entries) => entries.map((name, index) => {
    const item = `「${name}」的哲学`;
    const roles = characters.filter((role) => role.talent === item).sort((a, b) => b.star - a.star || b.id - a.id);
    return { name, region: locations[index]!, color: regionColors[index]!, roles, item };
  })).filter(({ roles }) => roles.length);
  return { birthdays, materials };
}

export function genshinCalendarPortrait(name: string, type: "face" | "card") {
  return safeGuideName(name) ? join(characterRoot, name, "imgs", type + ".webp") : undefined;
}

export function genshinCalendarMaterial(name: string, type: "talent" | "weekly") {
  return safeGuideName(name) ? join(materialRoot, type, name + ".webp") : undefined;
}
