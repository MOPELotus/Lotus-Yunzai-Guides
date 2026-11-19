import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { lockFile } from "../../lib/file-lock.ts";
import { guideGames, safeGuideName, type GuideGame } from "./role-guide-input.ts";
import { findGuidePack, isGuideImage, matchesGuideImage, readGuideImage, roleImageLimit, writeGuideFile, type GuideImage } from "./role-image-files.ts";
import { fetchMoraBlobs, moraSourceRef, moraTeamSource, prepareMoraGit } from "./team-resources.ts";

const revision = /^[0-9a-f]{40}$/u;
type Blob = { readonly source: string; readonly hash: string };
type RolePack = { readonly checkedAt: number; readonly files: readonly Blob[]; readonly images: readonly GuideImage[] };
const refreshAfter = 24 * 60 * 60 * 1000;

async function readPack(directory: string): Promise<RolePack | undefined> {
  try {
    const { checkedAt, files } = JSON.parse(await readFile(join(directory, "index.json"), "utf8")) as RolePack;
    if (!Number.isFinite(checkedAt) || !Array.isArray(files) || files.length > 24) return;
    const images: GuideImage[] = [];
    for (const { source, hash } of files) {
      if (typeof source !== "string" || !safeGuideName(source) || typeof hash !== "string" || !revision.test(hash)) return;
      const bytes = await readGuideImage(directory, hash);
      if (!bytes) return;
      images.push({ source, bytes });
    }
    return { checkedAt, files, images };
  } catch {}
}

export function createMoraRolePack(options: {
  readonly root: string;
  readonly fallback?: string;
  readonly upstream?: string;
  readonly signal?: AbortSignal;
}) {
  const pending = new Map<string, Promise<readonly GuideImage[]>>();
  async function read(game: GuideGame, name: string, force: boolean): Promise<readonly GuideImage[]> {
    const gamePath = guideGames[game].pack;
    const directory = join(options.root, gamePath, name);
    const existing = await readPack(directory);
    if (!force && existing && Date.now() - existing.checkedAt < refreshAfter) return existing.images;
    const timeout = AbortSignal.timeout(75_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      signal.throwIfAborted();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const lock = await lockFile(join(directory, "refresh.lock"), "角色攻略");
      let temporary: string | undefined;
      try {
        const current = await readPack(directory);
        if (!force && current && Date.now() - current.checkedAt < refreshAfter) return current.images;
        temporary = await mkdtemp(join(directory, ".refresh-"));
        const git = await prepareMoraGit(temporary, options.upstream ?? moraTeamSource, signal);
        const path = `${gamePath}/Roles/Guides`;
        const index = (await git(["ls-tree", "-r", "-z", moraSourceRef, "--", path])).toString("utf8");
        const files = new Map<string, string>();
        for (const line of index.split("\0")) {
          const [metadata, file] = line.split("\t", 2);
          if (!file?.startsWith(path + "/")) continue;
          const [author, namePart, ...rest] = file.slice(path.length + 1).split("/");
          if (!author || !safeGuideName(author) || !namePart || rest.length || !matchesGuideImage(namePart, name) || files.has(author)) continue;
          const hash = /^100644 blob ([0-9a-f]{40})$/u.exec(metadata ?? "")?.[1];
          if (!hash) throw new Error("摩拉角色攻略原图格式无效。");
          files.set(author, hash);
        }
        if (files.size > 24) throw new Error("角色攻略来源数超限。");
        const missing = [...new Set(files.values())].filter((hash) => !current?.files.some((file) => file.hash === hash));
        await fetchMoraBlobs(git, missing);
        const cached = new Map(current?.files.map(({ hash }, i) => [hash, current.images[i]?.bytes]));
        const results: GuideImage[] = [];
        let total = 0;
        for (const [source, hash] of files) {
          let bytes = cached.get(hash);
          if (!bytes) {
            const size = Number((await git(["cat-file", "-s", hash])).toString().trim());
            if (!Number.isSafeInteger(size) || size < 1 || size > roleImageLimit) throw new Error("角色攻略原图大小无效。");
            bytes = await git(["cat-file", "blob", hash], undefined, roleImageLimit);
            if (bytes.byteLength !== size || !isGuideImage(bytes)) throw new Error("角色攻略原图不完整。");
            await writeGuideFile(join(directory, hash), bytes);
          }
          total += bytes.byteLength;
          if (total > 48 * 1024 * 1024) throw new Error("角色攻略原图总大小超限。");
          results.push({ source, bytes });
        }
        signal.throwIfAborted();
        await writeGuideFile(join(directory, "index.json"), JSON.stringify({
          checkedAt: Date.now(), files: Array.from(files, ([source, hash]) => ({ source, hash })),
        }));
        return results;
      } finally {
        try {
          if (temporary) await rm(temporary, { recursive: true, force: true });
        } finally {
          lock.close();
        }
      }
    } catch (error) {
      if (!signal.aborted && error instanceof Error && error.message.startsWith("无法读取上游摩拉资源")) {
        console.warn("[guides] 摩拉角色攻略资源无法刷新，保留已有原图。", error.message);
      }
      if (existing?.images.length) return existing.images;
      return options.fallback ? findGuidePack(join(options.fallback, gamePath, "Roles", "Guides"), name) : [];
    }
  }

  return (game: GuideGame, name: string, force: boolean) => {
    const key = `${game}/${name}`;
    if (!safeGuideName(name)) return Promise.resolve([]);
    const running = pending.get(key);
    if (running) return running;
    const operation = read(game, name, force).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  };
}
