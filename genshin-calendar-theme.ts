import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
// Calendar.getCharData and meta-gs/material/daily.js from Miao-Plugin (MIT).
import { join } from "node:path";
import { readGuideFile } from "./role-image-files.ts";
import { safeGuideName } from "./role-guide-input.ts";

const talents = [
  [$t("genshin-calendar-theme.text_d1047eed5d"), $t("genshin-calendar-theme.text_b28c4dbf42"), $t("genshin-calendar-theme.text_36ea39c9aa"), $t("genshin-calendar-theme.text_26e4c50e4b"), $t("genshin-calendar-theme.text_bcefdeff3f"), $t("genshin-calendar-theme.text_9786bee8c7"), $t("genshin-calendar-theme.text_33c4b04477"), $t("genshin-calendar-theme.text_5cc3c16a14")],
  [$t("genshin-calendar-theme.text_b0016d937e"), $t("genshin-calendar-theme.text_81dcb34d9e"), $t("genshin-calendar-theme.text_0b829e82db"), $t("genshin-calendar-theme.text_2fbb66d6ed"), $t("genshin-calendar-theme.text_1ddaa4cb37"), $t("genshin-calendar-theme.text_79f4146091"), $t("genshin-calendar-theme.text_34ba55ee06"), $t("genshin-calendar-theme.text_87bb71140b")],
  [$t("genshin-calendar-theme.text_d4d2194cd7"), $t("genshin-calendar-theme.text_bbb72f61f1"), $t("genshin-calendar-theme.text_0008bef9ff"), $t("genshin-calendar-theme.text_336ccda3a4"), $t("genshin-calendar-theme.text_c2c1845c3b"), $t("genshin-calendar-theme.text_988ca3fd4e"), $t("genshin-calendar-theme.text_adbda297b3"), $t("genshin-calendar-theme.text_5af16a87ad")],
] as const;
const locations = [$t("genshin-calendar-theme.text_6b557bf926"), $t("genshin-calendar-theme.text_8c78af3e64"), $t("genshin-calendar-theme.text_0b93dbd19e"), $t("genshin-calendar-theme.text_68335fcf17"), $t("genshin-calendar-theme.text_e8ac469478"), $t("genshin-calendar-theme.text_979954d006"), $t("genshin-calendar-theme.text_3e929dfa54"), $t("genshin-calendar-theme.text_488a37f68b")];
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
    const item = $t("genshin-calendar-theme.text_989e7d532a", { "name": name });
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
