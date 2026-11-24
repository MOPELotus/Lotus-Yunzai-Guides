import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { lockFile } from "../../lib/file-lock.ts";
import { guideGames, moraSourcePath, safeGuideName, type GuideGame } from "./role-guide-input.ts";
import { findGuidePack, isGuideImage, matchesGuideImage, readGuideFile, roleImageLimit, writeGuideFile, type GuideImage } from "./role-image-files.ts";
import { fetchGuideBlobs, guideBlobId, guideSourceRef, guideSource, prepareGuideSourceGit } from "./team-resources.ts";

const revision = /^[0-9a-f]{40}$/u;
type Blob = { readonly source: string; readonly hash: string };
type RolePack = { readonly checkedAt: number; readonly files: readonly Blob[]; readonly images: readonly GuideImage[] };
const refreshAfter = 24 * 60 * 60 * 1000;
const retryAfter = 120_000;
export const referenceNotes = "RefStat:RefNotes.yaml";
export type RolePackFallback = string | readonly string[];
export type RolePackSnapshot = () => Promise<{ readonly directory: string; readonly checkedAt: number } | undefined>;
const notesLimit = 128 * 1024;

function hasImage(files: readonly GuideImage[]): boolean {
  return files.some(({ source }) => source !== referenceNotes);
}

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

export function createRoleResourcePack(options: {
  readonly root: string;
  readonly fallback?: RolePackFallback;
  readonly snapshot?: RolePackSnapshot;
  readonly automatic?: boolean;
  readonly upstream?: string;
  readonly signal?: AbortSignal;
  readonly references?: boolean;
}) {
  const pending = new Map<string, Promise<readonly GuideImage[]>>();
  const recentAttempts = new Map<string, number>();
  const fallbacks = typeof options.fallback === "string" ? [options.fallback] : options.fallback ?? [];

  async function directoryFiles(root: string, game: GuideGame, name: string) {
    for (const folder of [game, guideGames[game].pack]) {
      const local = join(root, folder, "Roles");
      const files = await (options.references ? readReferenceFallback(local, game, name) : findGuidePack(join(local, "Guides"), name));
      if (hasImage(files)) return files;
    }
    return [];
  }

  async function localFiles(game: GuideGame, name: string) {
    const snapshot = await options.snapshot?.();
    for (const root of snapshot ? [snapshot.directory, ...fallbacks] : fallbacks) {
      const files = await directoryFiles(root, game, name);
      if (hasImage(files)) return files;
    }
    return [];
  }

  async function read(game: GuideGame, name: string, force: boolean, retained: RolePack | undefined): Promise<readonly GuideImage[]> {
    const gamePath = guideGames[game].pack;
    const directory = join(options.root, gamePath, name);
    const timeout = AbortSignal.timeout(75_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      signal.throwIfAborted();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const lock = await lockFile(join(directory, "refresh.lock"), "角色攻略");
      let temporary: string | undefined;
      try {
        const current = await readPack(directory) ?? retained;
        retained = current;
        if (!force && current && Date.now() - current.checkedAt < refreshAfter) return current.images;
        temporary = await mkdtemp(join(directory, ".refresh-"));
        const git = await prepareGuideSourceGit(temporary, options.upstream ?? guideSource, signal);
        const originalPath = options.references ? `${gamePath}/Roles` : `${gamePath}/Roles/Guides`;
        const names = [moraSourcePath(originalPath), originalPath];
        const paths = options.references ? names.flatMap(path => [`${path}/RefStat`, `${path}/YieldCurve`]) : names;
        const index = (await git(["ls-tree", "-r", "-z", guideSourceRef, "--", ...paths])).toString("utf8");
        const files = new Map<string, string>();
        const renamed = new Set<string>();
        for (const line of index.split("\0")) {
          const [metadata, file] = line.split("\t", 2);
          const path = names.find(name => file?.startsWith(name + "/"));
          if (!path || !file) continue;
          const [author, namePart, ...rest] = file.slice(path.length + 1).split("/");
          if (!author || !safeGuideName(author) || !namePart || !safeGuideName(namePart) || rest.length) continue;
          const source = options.references ? referenceSource(game, name, author, namePart) : matchesGuideImage(namePart, name) ? author : undefined;
          if (!source || renamed.has(source) || (path === originalPath && files.has(source))) continue;
          const hash = /^100644 blob ([0-9a-f]{40})$/u.exec(metadata ?? "")?.[1];
          if (!hash) throw new Error("角色攻略原图格式无效。");
          files.set(source, hash);
          if (path !== originalPath) renamed.add(source);
        }
        if (files.size > 24) throw new Error("角色攻略来源数超限。");
        const persisted = new Map<string, Buffer>();
        for (const [index, { hash }] of (current?.files ?? []).entries()) {
          const bytes = current?.images[index]?.bytes;
          if (bytes && guideBlobId(bytes) === hash) persisted.set(hash, bytes);
        }
        const matching = new Map(persisted);
        const ids = new Set(files.values());
        if ([...ids].some((hash) => !matching.has(hash))) {
          for (const { bytes } of await localFiles(game, name)) {
            const hash = guideBlobId(bytes);
            if (ids.has(hash)) matching.set(hash, bytes);
          }
        }
        await fetchGuideBlobs(git, [...ids].filter((hash) => !matching.has(hash)));
        const results: GuideImage[] = [];
        let total = 0;
        for (const [source, hash] of files) {
          let bytes = matching.get(hash);
          if (!bytes) {
            const limit = source === referenceNotes ? notesLimit : roleImageLimit;
            const size = Number((await git(["cat-file", "-s", hash])).toString().trim());
            if (!Number.isSafeInteger(size) || size < 1 || size > limit) throw new Error("角色攻略资源大小无效。");
            bytes = await git(["cat-file", "blob", hash], undefined, limit);
            if (bytes.byteLength !== size || guideBlobId(bytes) !== hash || !validFile(source, bytes)) throw new Error("角色攻略资源不完整。");
          }
          if (!persisted.has(hash)) {
            signal.throwIfAborted();
            await writeGuideFile(join(directory, hash), bytes);
            persisted.set(hash, bytes);
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
      if (!signal.aborted && error instanceof Error && error.message.startsWith("无法读取上游攻略资源")) {
        console.warn("[guides] 角色攻略资源无法刷新，保留已有原图。", error.message);
      }
      return retained && hasImage(retained.images) ? retained.images : localFiles(game, name);
    }
  }

  function refresh(key: string, game: GuideGame, name: string, force: boolean, existing: RolePack | undefined) {
    const running = pending.get(key);
    if (running) return running;
    recentAttempts.delete(key);
    recentAttempts.set(key, Date.now());
    if (recentAttempts.size > 256) recentAttempts.delete(recentAttempts.keys().next().value!);
    const operation = read(game, name, force, existing).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  }

  return async (game: GuideGame, name: string, force: boolean): Promise<readonly GuideImage[]> => {
    if (!safeGuideName(name)) return [];
    const key = `${game}/${name}`;
    const existing = await readPack(join(options.root, guideGames[game].pack, name));
    if (force) return refresh(key, game, name, true, existing);
    const snapshot = await options.snapshot?.();
    if (snapshot) {
      if (existing && existing.checkedAt >= snapshot.checkedAt && hasImage(existing.images)) return existing.images;
      const images = await directoryFiles(snapshot.directory, game, name);
      if (hasImage(images)) return images;
    }
    if (existing && Date.now() - existing.checkedAt < refreshAfter) return existing.images;

    const cached = existing && hasImage(existing.images) ? existing.images : await localFiles(game, name);
    if (!cached.length) return refresh(key, game, name, false, existing);
    if (!options.automatic && !options.signal?.aborted && Date.now() - (recentAttempts.get(key) ?? 0) >= retryAfter) {
      // Keep a verified local image usable while the original source refreshes.
      void refresh(key, game, name, false, existing).catch(() => {});
    }
    return cached;
  };
}
