import { join } from "node:path";
import type { CommandReply } from "../../lib/commands.ts";
import type { OriginalRoleResources } from "./original-role-resources.ts";
import { readGuideImage } from "./role-image-files.ts";

// Names and enumeration order of the original Mora Banners directory.
export const bannerFiles = ["星武器-光锥.png", "星角色.png", "武器.png", "角色.png"] as const;

export function createBannerTables(resources: Pick<OriginalRoleResources, "current" | "refresh">,
  fallbacks: readonly string[], forward: boolean) {
  let retryAt = 0;

  async function lookup(files: readonly string[]): Promise<CommandReply> {
    const title = "复刻时间表";
    async function images(directory: string) {
      const list = await Promise.all(files.map(file => readGuideImage(directory, join("Banners", file))));
      return list.filter(bytes => bytes !== undefined).map(file => ({ type: "image" as const, file }));
    }

    const current = await resources.current();
    const directories = current ? [current.directory, ...fallbacks] : fallbacks;
    let available: Awaited<ReturnType<typeof images>> = [];
    for (const directory of directories) {
      const list = await images(directory);
      if (list.length > available.length) available = list;
      if (available.length === files.length) break;
    }
    if (!available.length && Date.now() >= retryAt) {
      try {
        await resources.refresh();
        const snapshot = await resources.current();
        if (snapshot) available = await images(snapshot.directory);
      } catch {
        retryAt = Date.now() + 120_000;
      }
    }
    if (!available.length) return "原复刻表暂不可用，请稍后再试。";
    if (available.length === 1) return available[0]!;
    return forward ? { type: "forward", nodes: [title, ...available] } : [title, ...available];
  }

  return (message: string) => {
    const match = /^#?(原神|星铁)?(角色|武器|光锥)?复刻表$/u.exec(message.trim());
    if (!match) return;
    const [, game, type] = match;
    return lookup(bannerFiles.filter(file => (game !== "星铁" || file.startsWith("星")) && (!type || file.includes(type))));
  };
}
