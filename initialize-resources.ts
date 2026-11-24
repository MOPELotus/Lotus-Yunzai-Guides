import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ResourceProgressCallback } from "../../lib/resource-progress.ts";
import { createOriginalRoleResources } from "./original-role-resources.ts";
import { createTeamResources } from "./team-resources.ts";

/** Shared paths/providers for explicit initialization and scheduled resource updates. */
export function createGuideResourcePreparation(root: URL, signal: AbortSignal, onProgress?: ResourceProgressCallback, logProgress = false) {
  const data = (path: string) => fileURLToPath(new URL(path, root));
  const cache = Bun.env.LOTUS_GUIDES_ROLE_DIR?.trim() || data("data/guides/roleGuides/");
  const configuredPack = Bun.env.LOTUS_GUIDES_MORA_PACK_DIR?.trim();
  const guidePack = configuredPack ? [configuredPack] : [data("data/guides/mora-plugin-res/"),
    data("plugins/mora-plugin/resources/mora-plugin-res/"), data("backup/plugins/mora-plugin/resources/mora-plugin-res/")];
  const original = createOriginalRoleResources({ root: data("data/guides/role-origin/"), cache, fallbacks: guidePack, onProgress, logProgress, signal });
  const bannerResources = createOriginalRoleResources({ root: data("data/guides/banner-origin/"), cache, fallbacks: guidePack, onProgress, logProgress, signal, scope: "banners" });
  const abyssResources = createOriginalRoleResources({ root: data("data/guides/abyss-reference-origin/"), cache, fallbacks: guidePack, onProgress, logProgress, signal, scope: "abyss" });
  const resources = Bun.env.LOTUS_GUIDES_TEAM_DIR?.trim() ? undefined : createTeamResources({ root: data("data/guides/mora/"),
    fallback: data("data/guides/Genshin/TeamGuides/"), alternatives: guidePack.flatMap(pack => ["gs", "Genshin"].map(game => join(pack, game, "TeamGuides"))), signal, onProgress, logProgress });
  return { cache, guidePack, original, bannerResources, abyssResources, resources };
}
export async function prepareGuideResources(root: URL, signal: AbortSignal, onProgress?: ResourceProgressCallback) {
  const sources = createGuideResourcePreparation(root, signal, onProgress);
  for (const source of [sources.original, sources.resources, sources.bannerResources, sources.abyssResources]) {
    signal.throwIfAborted();
    if (source) await source.refresh();
  }
}
