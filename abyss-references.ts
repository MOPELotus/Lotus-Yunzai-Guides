import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CommandReply } from "../../lib/commands.ts";
import { createOriginalImageLookup } from "./original-image-lookup.ts";
import type { OriginalRoleResources } from "./original-role-resources.ts";
import { moraSourcePath, safeGuideName } from "./role-guide-input.ts";
import { readGuideImage } from "./role-image-files.ts";

export const abyssVersionDirectory = "Genshin/Abyss/Version";
const historyDirectory = `${abyssVersionDirectory}/history12`;
const teamDirectory = "Genshin/Abyss/Teams/卡玛sei亚";
const historical = [
  `${historyDirectory}/历代11-3最低输出量.jpg`, `${historyDirectory}/历代12-1最低输出量.jpg`,
  `${historyDirectory}/历代12-2最低输出量.jpg`, `${historyDirectory}/历代12-3最低输出量.jpg`,
] as const;
const originalTeam = `${teamDirectory}/4.8.png`;
export const abyssReferencePaths = [abyssVersionDirectory, teamDirectory];
export const originalAbyssVersion = `${abyssVersionDirectory}/1.0/1.0-11.jpg`;
const opening = [originalAbyssVersion, `${abyssVersionDirectory}/1.0/1.0-12.jpg`] as const;
export const requiredAbyssReferences = [...historical, originalTeam, ...opening] as const;

function versionImage(version: string, file: string) {
  return /^[1-9]\.\d$/u.test(version) && safeGuideName(file) && file.startsWith(version) && /\.(?:png|jpe?g|webp)$/iu.test(file);
}

export function isAbyssReferencePath(path: string) {
  if (historical.some(file => file === path)) return true;
  if (path.startsWith(teamDirectory + "/")) return /^[1-9]\.\d\.png$/u.test(path.slice(teamDirectory.length + 1));
  if (!path.startsWith(abyssVersionDirectory + "/")) return false;
  const [version, file, extra] = path.slice(abyssVersionDirectory.length + 1).split("/");
  return !!version && !!file && extra === undefined && versionImage(version, file);
}

export function createAbyssReferences(resources: Pick<OriginalRoleResources, "current" | "refresh">,
  fallbacks: readonly string[], forward: boolean) {
  const find = createOriginalImageLookup(resources, fallbacks);
  let retryVersionAt = 0;

  async function versionHistory(version: string): Promise<CommandReply | undefined> {
    const title = `原神${version}深渊`;
    if (version === "1.0") {
      const { images, missing } = await find(opening);
      if (!images.length) return;
      if (missing.length) return [title, `原图暂缺${missing.map(file => basename(file)).join("、")}。`, ...images];
      const nodes = [title, ...images];
      return forward ? { type: "forward", nodes } : nodes;
    }
    const relative = `${abyssVersionDirectory}/${version}`;
    async function read(directory: string) {
      for (const path of [moraSourcePath(relative), relative]) {
        const entries = await readdir(join(directory, path), { withFileTypes: true }).catch(() => []);
        const files = entries.filter(entry => entry.isFile() && versionImage(version, entry.name)).map(entry => entry.name).sort();
        const images = (await Promise.all(files.map(file => readGuideImage(directory, `${path}/${file}`))))
          .filter(image => image !== undefined).map(file => ({ type: "image" as const, file }));
        if (images.length) return images;
      }
      return [];
    }

    const current = await resources.current();
    let images = current ? await read(current.directory) : [];
    for (const directory of fallbacks) {
      if (images.length) break;
      images = await read(directory);
    }
    if (!images.length && Date.now() >= retryVersionAt &&
        (!current || !(await lstat(join(current.directory, originalAbyssVersion)).catch(() => undefined))?.isFile())) {
      try {
        await resources.refresh();
        const snapshot = await resources.current();
        if (snapshot) images = await read(snapshot.directory);
      } catch {
        retryVersionAt = Date.now() + 120_000;
      }
    }
    if (!images.length) return;
    if (images.length === 1) return images[0]!;
    const nodes = [title, ...images];
    return forward ? { type: "forward", nodes } : nodes;
  }

  async function history(room: string): Promise<CommandReply> {
    const files = room === "层" ? historical : historical.filter(path => path.endsWith(`历代12${room}最低输出量.jpg`));
    const { images, missing } = await find(files);
    if (!images.length) return "原深渊最低输出量图暂不可用，请稍后再试。";
    if (files.length === 1) return images[0]!;
    const notice = missing.length && `原图暂缺${missing.map(file => basename(file, ".jpg")).join("、")}。`;
    const nodes = ["历代深渊12层最低输出量", ...(notice ? [notice] : []), ...images];
    return forward && images.length > 1 ? { type: "forward", nodes } : nodes;
  }

  return (message: string): Promise<CommandReply | undefined> | undefined => {
    const input = message.trim();
    const abyssVersion = /^#?(?:原神)?([1-9]\.\d)深渊$/u.exec(input)?.[1];
    if (abyssVersion) return versionHistory(abyssVersion);
    const room = /^#?历代12(层|-[1-3])(?:最低输出量)?$/u.exec(input)?.[1];
    if (room) return history(room);
    const version = /^#?([1-9]\.\d)深渊阵容(?:参考|推荐)?$/u.exec(input)?.[1];
    if (version) {
      const file = `${teamDirectory}/${version}.png`;
      return find([file], file === originalTeam).then(({ images }) => images[0] ?? `暂无${version}深渊阵容`);
    }
  };
}
