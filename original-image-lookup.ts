import type { OriginalRoleResources } from "./original-role-resources.ts";
import { readGuideImage } from "./role-image-files.ts";

export function createOriginalImageLookup(resources: Pick<OriginalRoleResources, "current" | "refresh">, fallbacks: readonly string[]) {
  let retryAt = 0;

  return async (files: readonly string[], refreshMissing = true) => {
    async function read(directory: string) {
      const list = await Promise.all(files.map(file => readGuideImage(directory, file)));
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
    if (available.missing.length && (refreshMissing || !current) && Date.now() >= retryAt) {
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
    return available;
  };
}
