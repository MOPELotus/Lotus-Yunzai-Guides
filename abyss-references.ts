import { basename } from "node:path";
import type { CommandReply } from "../../lib/commands.ts";
import { createOriginalImageLookup } from "./original-image-lookup.ts";
import type { OriginalRoleResources } from "./original-role-resources.ts";

const historyDirectory = "Genshin/Abyss/Version/history12";
const teamDirectory = "Genshin/Abyss/Teams/卡玛sei亚";
const historical = [
  `${historyDirectory}/历代11-3最低输出量.jpg`, `${historyDirectory}/历代12-1最低输出量.jpg`,
  `${historyDirectory}/历代12-2最低输出量.jpg`, `${historyDirectory}/历代12-3最低输出量.jpg`,
] as const;
const originalTeam = `${teamDirectory}/4.8.png`;
export const abyssReferencePaths = [historyDirectory, teamDirectory];
export const requiredAbyssReferences = [...historical, originalTeam] as const;

export function isAbyssReferencePath(path: string) {
  return historical.some(file => file === path) ||
    (path.startsWith(teamDirectory + "/") && /^[1-9]\.\d\.png$/u.test(path.slice(teamDirectory.length + 1)));
}

export function createAbyssReferences(resources: Pick<OriginalRoleResources, "current" | "refresh">,
  fallbacks: readonly string[], forward: boolean) {
  const find = createOriginalImageLookup(resources, fallbacks);

  async function history(room: string): Promise<CommandReply> {
    const files = room === "层" ? historical : historical.filter(path => path.endsWith(`历代12${room}最低输出量.jpg`));
    const { images, missing } = await find(files);
    if (!images.length) return "原深渊最低输出量图暂不可用，请稍后再试。";
    if (files.length === 1) return images[0]!;
    const notice = missing.length && `原图暂缺${missing.map(file => basename(file, ".jpg")).join("、")}。`;
    const nodes = ["历代深渊12层最低输出量", ...(notice ? [notice] : []), ...images];
    return forward && images.length > 1 ? { type: "forward", nodes } : nodes;
  }

  return (message: string): Promise<CommandReply> | undefined => {
    const input = message.trim();
    const room = /^#?历代12(层|-[1-3])(?:最低输出量)?$/u.exec(input)?.[1];
    if (room) return history(room);
    const version = /^#?([1-9]\.\d)深渊阵容(?:参考|推荐)?$/u.exec(input)?.[1];
    if (version) {
      const file = `${teamDirectory}/${version}.png`;
      return find([file], file === originalTeam).then(({ images }) => images[0] ?? `暂无${version}深渊阵容`);
    }
  };
}
