import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { lockFile } from "../../lib/file-lock.ts";
import { guideGames, safeGuideName, type GuideGame } from "./role-guide-input.ts";
import { findGuidePack, isGuideImage, matchesGuideImage, readGuideFile, roleImageLimit, writeGuideFile, type GuideImage } from "./role-image-files.ts";
import { fetchMoraBlobs, moraSourceRef, moraTeamSource, prepareMoraGit } from "./team-resources.ts";

const revision = /^[0-9a-f]{40}$/u;
type Blob = { readonly source: string; readonly hash: string };
type RolePack = { readonly checkedAt: number; readonly files: readonly Blob[]; readonly images: readonly GuideImage[] };
const refreshAfter = 24 * 60 * 60 * 1000;
export const referenceNotes = "RefStat:RefNotes.yaml";
const notesLimit = 128 * 1024;

function validFile(source: string, bytes: Buffer): boolean {
  if (source !== referenceNotes) return isGuideImage(bytes);
  try {
    const data: unknown = Bun.YAML.parse(bytes.toString("utf8"));
    return !!data && typeof data === "object" && !Array.isArray(data);
  } catch {
    return false;
  }
}

async function readPack(directory: string): Promise<RolePack | undefined> {
  try {
    const { checkedAt, files } = JSON.parse(await readFile(join(directory, "index.json"), "utf8")) as RolePack;
    if (!Number.isFinite(checkedAt) || !Array.isArray(files) || files.length > 24) return;
    const images: GuideImage[] = [];
    for (const { source, hash } of files) {
      if (typeof source !== "string" || !safeGuideName(source) || typeof hash !== "string" || !revision.test(hash)) return;
      const bytes = await readGuideFile(directory, hash, source === referenceNotes ? notesLimit : roleImageLimit);
      if (!bytes || !validFile(source, bytes)) return;
      images.push({ source, bytes });
    }
    return { checkedAt, files, images };
  } catch {}
}

function referenceSource(game: GuideGame, name: string, category: string, file: string): string | undefined {
  if (category !== "RefStat" && (game !== "gs" || category !== "YieldCurve")) return;
  if (name === "帮助") {
    if (file !== "帮助.png" || category !== (game === "sr" ? "RefStat" : "YieldCurve")) return;
  } else if (!(category === "RefStat" && file === "RefNotes.yaml") &&
      !matchesGuideImage(file, name) && !(file.startsWith(name + "-") && /\.png$/u.test(file))) {
    return;
  }
  return `${category}:${file}`;
}

async function readReferenceFallback(root: string, game: GuideGame, name: string) {
  const results: GuideImage[] = [];
  for (const category of ["RefStat", "YieldCurve"]) {
    for (const file of await readdir(join(root, category)).catch(() => [] as string[])) {
      if (!safeGuideName(file)) continue;
      const source = referenceSource(game, name, category, file);
      if (!source) continue;
      const bytes = await readGuideFile(root, join(category, file), source === referenceNotes ? notesLimit : roleImageLimit);
      if (bytes && validFile(source, bytes)) results.push({ source, bytes });
    }
  }
  return results;
}

export function createMoraRolePack(options: {
  readonly root: string;
  readonly fallback?: string;
  readonly upstream?: string;
  readonly signal?: AbortSignal;
  readonly references?: boolean;
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
        const path = options.references ? `${gamePath}/Roles` : `${gamePath}/Roles/Guides`;
        const paths = options.references ? [`${path}/RefStat`, `${path}/YieldCurve`] : [path];
        const index = (await git(["ls-tree", "-r", "-z", moraSourceRef, "--", ...paths])).toString("utf8");
        const files = new Map<string, string>();
        for (const line of index.split("\0")) {
          const [metadata, file] = line.split("\t", 2);
          if (!file?.startsWith(path + "/")) continue;
          const [author, namePart, ...rest] = file.slice(path.length + 1).split("/");
          if (!author || !safeGuideName(author) || !namePart || !safeGuideName(namePart) || rest.length) continue;
          const source = options.references ? referenceSource(game, name, author, namePart) : matchesGuideImage(namePart, name) ? author : undefined;
          if (!source || files.has(source)) continue;
          const hash = /^100644 blob ([0-9a-f]{40})$/u.exec(metadata ?? "")?.[1];
          if (!hash) throw new Error("摩拉角色攻略原图格式无效。");
          files.set(source, hash);
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
            const limit = source === referenceNotes ? notesLimit : roleImageLimit;
            const size = Number((await git(["cat-file", "-s", hash])).toString().trim());
            if (!Number.isSafeInteger(size) || size < 1 || size > limit) throw new Error("角色攻略资源大小无效。");
            bytes = await git(["cat-file", "blob", hash], undefined, limit);
            if (bytes.byteLength !== size || !validFile(source, bytes)) throw new Error("角色攻略资源不完整。");
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
      if (!options.fallback) return [];
      const local = join(options.fallback, gamePath, "Roles");
      return options.references ? readReferenceFallback(local, game, name) : findGuidePack(join(local, "Guides"), name);
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
