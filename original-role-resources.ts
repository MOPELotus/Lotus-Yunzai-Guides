import { createInitializationProgress } from "../../lib/initialization-progress.ts";
import { reportResourceProgress, type ResourceProgressCallback } from "../../lib/resource-progress.ts";
import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readlink, readdir, rename, rm, symlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lockFile } from "../../lib/file-lock.ts";
import { abyssReferencePaths, abyssVersionDirectory, isAbyssReferencePath, originalAbyssVersion, requiredAbyssReferences } from "./abyss-references.ts";
import { bannerFiles } from "./banner-tables.ts";
import { canonicalMoraPath, guideGames, moraSourcePath, safeGuideName } from "./role-guide-input.ts";
import { isGuideImage, roleImageLimit, writeGuideFile } from "./role-image-files.ts";
import { cleanGuideStages, fetchGuideBlobs, guideBlobId, guideSource, guideSourceRef,
  prepareGuideSourceGit, readLocalGuideBlob, verifyGuideSnapshot } from "./team-resources.ts";

const rolePaths = ["Genshin/Roles/Guides", "Genshin/Roles/RefStat", "Genshin/Roles/YieldCurve",
  "StarRail/Roles/Guides", "StarRail/Roles/RefStat", "ZenlessZoneZero/Roles/Guides"] as const;
const sourcePaths = { roles: rolePaths, banners: ["Banners"], abyss: abyssReferencePaths } as const;
type Scope = keyof typeof sourcePaths;
const hashPattern = /^[0-9a-f]{40}$/u;
const snapshotPattern = /^snapshots\/([0-9a-f]{40})-[0-9a-f-]{36}$/u;
const notesLimit = 128 * 1024;
const freshness = 24 * 60 * 60 * 1000;

interface Resource {
  readonly path: string;
  readonly hash: string;
  readonly notes: boolean;
}

function sourceResources(output: Uint8Array, scope: Scope) {
  const selected = new Map<string, Resource>();
  for (const row of Buffer.from(output).toString("utf8").split("\0")) {
    const [metadata, ...rest] = row.split("\t");
    const rawPath = rest.join("\t");
    const path = canonicalMoraPath(rawPath);
    const base = sourcePaths[scope].find((candidate) => path.startsWith(candidate + "/"));
    if (!base) continue;
    const parts = path.slice(base.length + 1).split("/");
    if (parts.some((part) => !safeGuideName(part)) || parts.length !== (base.endsWith("/Guides") || base === abyssVersionDirectory ? 2 : 1)) continue;
    const file = parts.at(-1)!;
    if (scope === "banners" && !bannerFiles.some(name => name === file)) continue;
    if (scope === "abyss" && !isAbyssReferencePath(path)) continue;
    const notes = base.endsWith("/RefStat") && file === "RefNotes.yaml";
    if (!notes && !/\.(?:png|jpe?g|webp)$/iu.test(file)) continue;
    const hash = /^100644 blob ([0-9a-f]{40})$/u.exec(metadata ?? "")?.[1];
    if (!hash) throw new Error("角色原资源文件格式无效。");
    if (rawPath !== path || !selected.has(path)) selected.set(path, { path, hash, notes });
  }
  const resources = [...selected.values()].sort((left, right) => left.path.localeCompare(right.path));
  const requiredAbyssFileMissing = scope === "abyss" && !requiredAbyssReferences.every(path => resources.some(item => item.path === path));
  if (!resources.some(({ notes }) => !notes) || resources.length > 4000 || requiredAbyssFileMissing ||
      scope === "banners" && resources.length !== bannerFiles.length) {
    throw new Error("攻略原资源清单不完整。");
  }
  return resources;
}

function limit({ notes }: Resource) { return notes ? notesLimit : roleImageLimit; }

function valid({ notes }: Resource, bytes: Buffer) {
  if (!notes) return isGuideImage(bytes);
  try {
    const data = Bun.YAML.parse(bytes.toString("utf8"));
    return !!data && typeof data === "object" && !Array.isArray(data);
  } catch { return false; }
}

async function existingObjects(cache: string) {
  const found = new Map<string, { directory: string; file: string }>();
  for (const kind of ["mora", "mora-reference"]) {
    for (const { pack } of Object.values(guideGames)) {
      const directory = join(cache, kind, pack);
      const roles = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const role of roles) {
        if (!role.isDirectory() || !safeGuideName(role.name)) continue;
        for (const file of await readdir(join(directory, role.name)).catch(() => [])) {
          if (hashPattern.test(file) && !found.has(file)) found.set(file, { directory, file: join(role.name, file) });
        }
      }
    }
  }
  return found;
}

export type OriginalRoleResources = ReturnType<typeof createOriginalRoleResources>;

export function createOriginalRoleResources({ root, cache, fallbacks, signal, source = guideSource, scope = "roles", onProgress: configuredProgress, logProgress }: {
  readonly root: string;
  readonly cache: string;
  readonly fallbacks: readonly string[];
  readonly signal: AbortSignal;
  readonly source?: string;
  readonly scope?: Scope;
  readonly onProgress?: ResourceProgressCallback;
  readonly logProgress?: boolean;
}) {
  const paths = [...new Set(sourcePaths[scope].flatMap(path => [moraSourcePath(path), path]))];
  const batchSize = scope === "abyss" ? 32 : 8;
  const objects = join(root, "objects");
  const pending = join(root, "pending");
  const checked = join(root, "checked");
  let active: Promise<"updated" | "current"> | undefined;

  async function current() {
    try {
      const link = await readlink(join(root, "current"));
      const tree = snapshotPattern.exec(link)?.[1];
      if (!tree) return;
      const directory = join(root, link);
      const stat = await lstat(directory);
      if (stat.isDirectory()) return { directory, tree, checkedAt: stat.mtimeMs };
    } catch {}
  }

  async function download(): Promise<"updated" | "current"> {
    const attempt = AbortSignal.any([signal, AbortSignal.timeout(scope === "roles" ? 20 * 60 * 1000 : 75_000)]);
    attempt.throwIfAborted();
    const labels = { roles: "角色攻略", banners: "复刻表", abyss: "深渊参考" };
    const terminal = logProgress && !configuredProgress ? createInitializationProgress(labels[scope], { signal: attempt }) : undefined;
    const onProgress = configuredProgress ?? terminal?.update;
    let succeeded = false;
    const report = (phase: string, message: string, completed?: number, total?: number) =>
      reportResourceProgress(onProgress, attempt, `guides-${scope}-${phase}`, `${labels[scope]}：${message}`, completed, total);
    report("prepare", "准备资源");
    let lock: Awaited<ReturnType<typeof lockFile>> | undefined;
    let temporary: string | undefined;
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      lock = await lockFile(join(root, "refresh.lock"), "角色原资源");
      attempt.throwIfAborted();
      await cleanGuideStages(root, ".install-");
      await writeGuideFile(pending, "");
      temporary = await mkdtemp(join(root, ".install-"));
      const git = await prepareGuideSourceGit(temporary, source, attempt, onProgress);
      const resources = sourceResources(await git(["ls-tree", "-r", "-z", guideSourceRef, "--", ...paths]), scope);
      const tree = createHash("sha1").update(JSON.stringify(resources)).digest("hex");
      const previous = await current();
      if (previous?.tree === tree && await verifyGuideSnapshot(previous.directory,
        resources.map(item => ({ path: item.path, hash: item.hash, maxBytes: limit(item) })), attempt, onProgress)) {
        await writeGuideFile(checked, "");
        await rm(pending, { force: true });
        succeeded = true;
        return "current";
      }

      report("cache", "扫描本地缓存");
      const local = scope === "roles" ? await existingObjects(cache) : undefined;
      const stage = join(temporary, "stage");
      await mkdir(objects, { recursive: true });
      const unique = [...new Map(resources.map(item => [item.hash, item])).values()];
      for (let start = 0; start < unique.length; start += batchSize) {
        attempt.throwIfAborted();
        report("download", "核对并补全文件", start, unique.length);
        const missing: Resource[] = [];
        for (const item of unique.slice(start, start + batchSize)) {
          let bytes = await readLocalGuideBlob(objects, item.hash, item.hash, limit(item));
          if (bytes && valid(item, bytes)) continue;
          const entry = local?.get(item.hash);
          if (entry) bytes = await readLocalGuideBlob(entry.directory, entry.file, item.hash, limit(item));
          for (const directory of fallbacks) {
            if (bytes && valid(item, bytes)) break;
            bytes = await readLocalGuideBlob(directory, item.path, item.hash, limit(item)) ??
              await readLocalGuideBlob(directory, moraSourcePath(item.path), item.hash, limit(item));
          }
          if (bytes && valid(item, bytes)) await writeGuideFile(join(objects, item.hash), bytes);
          else missing.push(item);
        }
        report("fetch", `下载本批缺失文件（${missing.length} 项）`, start, unique.length);
        await fetchGuideBlobs(git, missing.map(({ hash }) => hash));
        for (const item of missing) {
          attempt.throwIfAborted();
          const bytes = await git(["cat-file", "blob", item.hash], undefined, limit(item));
          if (guideBlobId(bytes) !== item.hash || !valid(item, bytes)) throw new Error("角色原图不完整。");
          await writeGuideFile(join(objects, item.hash), bytes);
          report("fetch", `已取得 ${item.path}`);
        }
        report("download", "文件已校验并准备", Math.min(start + batchSize, unique.length), unique.length);
      }

      let publishedCount = 0;
      for (const item of resources) {
        attempt.throwIfAborted();
        const file = join(stage, item.path);
        await mkdir(dirname(file), { recursive: true });
        await link(join(objects, item.hash), file);
        report("install", "保存资源", ++publishedCount, resources.length);
      }
      const next = `snapshots/${tree}-${crypto.randomUUID()}`;
      const pointer = join(temporary, "pointer");
      await mkdir(join(root, "snapshots"), { recursive: true });
      await symlink(next, pointer, "dir");
      attempt.throwIfAborted();
      const published = new Date();
      await utimes(stage, published, published);
      await rename(stage, join(root, next));
      await rename(pointer, join(root, "current"));
      await writeGuideFile(checked, "");
      await rm(pending, { force: true });
      succeeded = true;
      return "updated";
    } finally {
      try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
      finally {
        if (succeeded) terminal?.complete();
        else terminal?.fail(attempt.aborted ? "资源准备已中止" : "资源准备失败");
        lock?.close();
      }
    }
  }

  return {
    current,
    async initialized() {
      const currentSnapshot = await current();
      if (await Bun.file(pending).exists() || !currentSnapshot ||
          scope === "abyss" && !(await lstat(join(currentSnapshot.directory, originalAbyssVersion)).catch(() => undefined))?.isFile()) return false;
      const stamp = await lstat(checked).catch(() => undefined);
      return stamp !== undefined && Date.now() - stamp.mtimeMs < freshness;
    },
    refresh() { return active ??= download().finally(() => { active = undefined; }); },
    async wait() { await active?.catch(() => {}); },
  };
}
