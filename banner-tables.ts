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
    async function read(directory: string) {
      const list = await Promise.all(files.map(file => readGuideImage(directory, join("Banners", file))));
      return {
        images: list.filter(bytes => bytes !== undefined).map(file => ({ type: "image" as const, file })),
        missing: files.filter((_, index) => list[index] === undefined),
      };
    }

    const current = await resources.current();
    const directories = current ? [current.directory, ...fallbacks] : fallbacks;
    let available: Awaited<ReturnType<typeof read>> = { images: [], missing: [...files] };
    for (const directory of directories) {
      const candidate = await read(directory);
      if (candidate.missing.length < available.missing.length) available = candidate;
      if (!available.missing.length) break;
    }
    if (available.missing.length && Date.now() >= retryAt) {
      try {
        await resources.refresh();
        const snapshot = await resources.current();
        if (snapshot) {
          const candidate = await read(snapshot.directory);
          if (candidate.missing.length < available.missing.length) available = candidate;
        }
      } catch {}
      if (available.missing.length) retryAt = Date.now() + 120_000;
    }
    const { images, missing } = available;
    if (!images.length) return "原复刻表暂不可用，请稍后再试。";
    const notice = missing.length && `原复刻表暂缺${missing.map(file => file.replace(/\.png$/u, "")).join("、")}。`;
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
