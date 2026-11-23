import { join } from "node:path";
import type { CommandReply } from "../../lib/commands.ts";
import { createRoleGuideCollections, type GuideFetch } from "./role-guide-collections.ts";
import { resolveGuideRole, safeGuideName } from "./role-guide-input.ts";
import { readGuideImage, writeGuideFile } from "./role-image-files.ts";

const materialCommand = /^#?(星铁|原神)?(更新)?([^\s#]+?)(?:突破|材料|素材|培养)$/u;
const reserved = /^(?:每日|今日|我的|全部|所有|每周|周[一二三四五六日天]|[一二三四五六日天]|天赋|武器|装备|养成|升级)$/u;
const alternateGenshinLayout = new Set(["雷电将军", "珊瑚宫心海", "菲谢尔", "托马", "八重神子", "九条裟罗", "辛焱", "神里绫华"]);

// These are the original material collections and image positions, separate from general guides.
const materialSources = {
  gs: { author: "友人A", sources: [[428421, "image_list", 1], [1164644, "image_list", 0], [1362644, "image_list", 2]] },
  sr: { author: "小橙子啊", sources: [[1998643, "post.images", 2], [2146693, "post.images", 0], [2279356, "image_list", 0]] },
} as const;

export function createRoleMaterials({ cache, legacy, fetch: transport, signal }: {
  readonly cache: string; readonly legacy?: string; readonly fetch?: GuideFetch; readonly signal?: AbortSignal;
}) {
  const { materialImage } = createRoleGuideCollections({ fetch: transport, signal });
  const pending = new Map<string, Promise<Buffer | undefined>>();

  async function readMaterial(cachePath: string) {
    return await readGuideImage(cache, cachePath) ?? (legacy ? await readGuideImage(legacy, cachePath) : undefined);
  }

  async function load(game: "gs" | "sr", name: string, update: boolean): Promise<Buffer | undefined> {
    const { author, sources } = materialSources[game];
    const primary = join(game, author, `${name}.jpg`);
    const alternative = join(game, "other", `${name}.jpg`);
    const oldPrimary = await readMaterial(primary);
    if (oldPrimary && !update) return oldPrimary;
    const oldAlternative = await readMaterial(alternative);
    for (const [position, [id, field, imageIndex]] of sources.entries()) {
      if (signal?.aborted) return;
      if (position === 1 && oldAlternative && !update) return oldAlternative;
      const index = id === 428421 && alternateGenshinLayout.has(name) ? 2 : imageIndex;
      const bytes = await materialImage(id, name, update, field, index);
      if (!bytes) continue;
      if (signal?.aborted) return;
      await writeGuideFile(join(cache, position === 0 ? primary : alternative), bytes,
        () => !signal?.aborted).catch(() => false);
      return bytes;
    }
    return oldPrimary ?? oldAlternative;
  }

  return (message: string, limit?: number): CommandReply | Promise<CommandReply> | undefined => {
    if (signal?.aborted) return;
    const match = materialCommand.exec(message.trim());
    if (!match || /^(?:绝区零|绝区)/u.test(match[3]!) || reserved.test(match[3]!)) return;
    const game = match[1] === "星铁" ? "sr" : "gs";
    const update = Boolean(match[2]);
    const role = resolveGuideRole(match[3]!, game);
    if (!role) return;
    if (typeof role === "string" || ["8001", "8003"].includes(role.id ?? "")) return "暂无主角素材。";
    if (!safeGuideName(role.name)) return;
    const key = `${game}/${role.name}`;
    const refreshKey = `${key}/refresh`;
    const target = update ? refreshKey : key;
    let current = pending.get(refreshKey) ?? pending.get(target);
    if (!current) {
      const previous = update ? pending.get(key) : undefined;
      current = Promise.resolve(previous).then(() => load(game, role.name, update)).finally(() => pending.delete(target));
      pending.set(target, current);
    }
    return current.then((bytes): CommandReply => {
      if (signal?.aborted) return [];
      if (!bytes) return `暂无${role.name}的原素材图，可用角色图鉴查看养成材料。`;
      if (limit !== undefined && bytes.byteLength > limit) return `${role.name}的素材图超过当前会话的单图大小上限。`;
      return { type: "image", file: bytes };
    });
  };
}
