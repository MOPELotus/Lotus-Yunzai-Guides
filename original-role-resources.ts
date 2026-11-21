import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readlink, readdir, rename, rm, symlink, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { lockFile } from "../../lib/file-lock.ts";
import { abyssReferencePaths, isAbyssReferencePath, requiredAbyssReferences } from "./abyss-references.ts";
import { bannerFiles } from "./banner-tables.ts";
import { guideGames, safeGuideName } from "./role-guide-input.ts";
import { isGuideImage, roleImageLimit, writeGuideFile } from "./role-image-files.ts";
import { cleanGuideStages, fetchGuideBlobs, guideBlobId, guideSource, guideSourceRef,
  prepareGuideSourceGit, readLocalGuideBlob } from "./team-resources.ts";

const rolePaths = ["Genshin/Roles/Guides", "Genshin/Roles/RefStat", "Genshin/Roles/YieldCurve",
  "StarRail/Roles/Guides", "StarRail/Roles/RefStat", "ZenlessZoneZero/Roles/Guides"] as const;
const sourcePaths = { roles: rolePaths, banners: ["Banners"], abyss: abyssReferencePaths } as const;
type Scope = keyof typeof sourcePaths;
const hashPattern = /^[0-9a-f]{40}$/u;
const snapshotPattern = /^snapshots\/([0-9a-f]{40})-[0-9a-f-]{36}$/u;
const batchSize = 8;
const notesLimit = 128 * 1024;
const freshness = 24 * 60 * 60 * 1000;

interface Resource {
  readonly path: string;
  readonly hash: string;
  readonly notes: boolean;
}

function sourceResources(output: Uint8Array, scope: Scope) {
  const resources: Resource[] = [];
  for (const row of Buffer.from(output).toString("utf8").split("\0")) {
    const [metadata, ...rest] = row.split("\t");
    const path = rest.join("\t");
    const base = sourcePaths[scope].find((candidate) => path.startsWith(candidate + "/"));
    if (!base) continue;
    const parts = path.slice(base.length + 1).split("/");
    if (parts.some((part) => !safeGuideName(part)) || parts.length !== (base.endsWith("/Guides") ? 2 : 1)) continue;
    const file = parts.at(-1)!;
    if (scope === "banners" && !bannerFiles.some(name => name === file)) continue;
    if (scope === "abyss" && !isAbyssReferencePath(path)) continue;
    const notes = base.endsWith("/RefStat") && file === "RefNotes.yaml";
    if (!notes && !/\.(?:png|jpe?g|webp)$/iu.test(file)) continue;
    const hash = /^100644 blob ([0-9a-f]{40})$/u.exec(metadata ?? "")?.[1];
    if (!hash) throw new Error("角色原资源文件格式无效。");
    resources.push({ path, hash, notes });
  }
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

export function createOriginalRoleResources({ root, cache, fallbacks, signal, source = guideSource, scope = "roles" }: {
  readonly root: string;
  readonly cache: string;
  readonly fallbacks: readonly string[];
  readonly signal: AbortSignal;
  readonly source?: string;
  readonly scope?: Scope;
}) {
  const paths = sourcePaths[scope];
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
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lock = await lockFile(join(root, "refresh.lock"), "角色原资源");
    let temporary: string | undefined;
    try {
      attempt.throwIfAborted();
      await cleanGuideStages(root, ".install-");
      await writeGuideFile(pending, "");
      temporary = await mkdtemp(join(root, ".install-"));
      const git = await prepareGuideSourceGit(temporary, source, attempt);
      const resources = sourceResources(await git(["ls-tree", "-r", "-z", guideSourceRef, "--", ...paths]), scope);
      const tree = createHash("sha1").update(JSON.stringify(resources)).digest("hex");
      const previous = await current();
      if (previous?.tree === tree && (scope === "roles" || (await Promise.all(resources.map(item =>
        readLocalGuideBlob(previous.directory, item.path, item.hash, limit(item))))).every(Boolean))) {
        await writeGuideFile(checked, "");
        await rm(pending, { force: true });
        return "current";
      }

      const local = scope === "roles" ? await existingObjects(cache) : undefined;
      const stage = join(temporary, "stage");
      await mkdir(objects, { recursive: true });
      const unique = [...new Map(resources.map(item => [item.hash, item])).values()];
      for (let start = 0; start < unique.length; start += batchSize) {
        attempt.throwIfAborted();
        const missing: Resource[] = [];
        for (const item of unique.slice(start, start + batchSize)) {
          let bytes = await readLocalGuideBlob(objects, item.hash, item.hash, limit(item));
          if (bytes && valid(item, bytes)) continue;
          const entry = local?.get(item.hash);
          if (entry) bytes = await readLocalGuideBlob(entry.directory, entry.file, item.hash, limit(item));
          for (const directory of fallbacks) {
            if (bytes && valid(item, bytes)) break;
            bytes = await readLocalGuideBlob(directory, item.path, item.hash, limit(item));
          }
          if (bytes && valid(item, bytes)) await writeGuideFile(join(objects, item.hash), bytes);
          else missing.push(item);
        }
        await fetchGuideBlobs(git, missing.map(({ hash }) => hash));
        for (const item of missing) {
          attempt.throwIfAborted();
          const bytes = await git(["cat-file", "blob", item.hash], undefined, limit(item));
          if (guideBlobId(bytes) !== item.hash || !valid(item, bytes)) throw new Error("角色原图不完整。");
          await writeGuideFile(join(objects, item.hash), bytes);
        }
      }

      for (const item of resources) {
        attempt.throwIfAborted();
        const file = join(stage, item.path);
        await mkdir(dirname(file), { recursive: true });
        await link(join(objects, item.hash), file);
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
      return "updated";
    } finally {
      try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
      finally { lock.close(); }
    }
  }

  return {
    current,
    async initialized() {
      if (await Bun.file(pending).exists() || !(await current())) return false;
      const stamp = await lstat(checked).catch(() => undefined);
      return stamp !== undefined && Date.now() - stamp.mtimeMs < freshness;
    },
    refresh() { return active ??= download().finally(() => { active = undefined; }); },
    async wait() { await active?.catch(() => {}); },
  };
}
