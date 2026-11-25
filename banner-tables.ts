import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
import { join } from "node:path";
import type { CommandReply } from "../../lib/commands.ts";
import type { OriginalRoleResources } from "./original-role-resources.ts";
import { createOriginalImageLookup } from "./original-image-lookup.ts";

// Names and enumeration order of the original Mora Banners directory.
export const bannerFiles = ["星武器-光锥.png", "星角色.png", "武器.png", "角色.png"] as const;

export function createBannerTables(resources: Pick<OriginalRoleResources, "current" | "refresh">,
  fallbacks: readonly string[], forward: boolean) {
  const find = createOriginalImageLookup(resources, fallbacks);

  async function lookup(files: readonly string[]): Promise<CommandReply> {
    const title = $t("banner-tables.text_56bb6c2f79");
    const { images, missing } = await find(files.map(file => join("Banners", file)));
    if (!images.length) return $t("banner-tables.text_7c5fc71e60");
    const notice = missing.length && $t("banner-tables.text_d0f7ae914c", { "value1": missing.map(file => file.slice("Banners/".length, -4)).join("、") });
    if (images.length === 1) return notice ? [notice, images[0]!] : images[0]!;
    const nodes = [title, ...(notice ? [notice] : []), ...images];
    return forward ? { type: "forward", nodes } : nodes;
  }

  return (message: string) => {
    const match = /^#?(原神|星铁)?(角色|武器|光锥)?复刻表$/u.exec(message.trim());
    if (!match) return;
    const [, game, type] = match;
    return lookup(bannerFiles.filter(file => (game !== "星铁" || file.startsWith("星")) && (!type || file.includes(type))));
  };
}
