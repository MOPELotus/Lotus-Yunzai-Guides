import { createInitializationProgress } from "../../lib/initialization-progress.ts";
import { reportResourceProgress, type ResourceProgressCallback } from "../../lib/resource-progress.ts";
// Source and refresh schedule adapted from Mora-Plugin apps/help.js.
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { devNull } from "node:os";
import { dirname, join } from "node:path";
import { lockFile } from "../../lib/file-lock.ts";
import { indexedTeamImages, pngHeader, readResource, teamGuideAuthors } from "./team-guides.ts";
import { writeGuideFile } from "./role-image-files.ts";
import { moraSourcePath } from "./role-guide-input.ts";

export const guideSource = "https://gitee.com/Rrrrrrray/mora-plugin-res.git";
export const guideSourceRef = "refs/heads/master";
const sourcePath = "Genshin/TeamGuides";
const indexPath = "teamGuides.yaml";
const gitId = /^[0-9a-f]{40}$/u;
const snapshotName = /^snapshots\/([0-9a-f]{40})-[0-9a-f-]{36}$/u;
const maxImage = 16 * 1024 * 1024;
const maxIndex = 1024 * 1024;
const maxSnapshot = 128 * 1024 * 1024;
const freshness = 24 * 60 * 60 * 1000;

function resourcePaths(file: string): boolean {
  if (file === indexPath) return true;
  const [author, name, ...rest] = file.split("/");
  return !rest.length && teamGuideAuthors.some((item) => item === author) &&
    !!name && !/[\\\u0000-\u001f\u007f]/u.test(name) && name.endsWith(".png");
}

function readGitTree(output: string, path: string): Map<string, string> {
  const objects = new Map<string, string>();
  for (const line of output.split("\0")) {
    if (!line) continue;
    const [metadata, source] = line.split("\t", 2);
    if (!source?.startsWith(`${path}/`)) throw new Error("配队资源路径无效。");
    const file = source.slice(path.length + 1);
    if (!resourcePaths(file)) continue;
    const id = /^100644 blob ([0-9a-f]{40})$/u.exec(metadata ?? "")?.[1];
    if (!id) throw new Error("配队资源须为原仓库的普通文件。");
    objects.set(file, id);
  }
  if (!objects.has(indexPath) || objects.size > 500) throw new Error("配队资源清单无效。");
  return objects;
}

async function managedSnapshot(root: string) {
  try {
    const link = await readlink(join(root, "current"));
    const tree = snapshotName.exec(link)?.[1];
    if (!tree) return;
    const directory = join(root, link);
    if (!(await lstat(directory)).isDirectory() || !(await lstat(join(directory, indexPath))).isFile()) return;
    return { directory, tree };
  } catch {
    return;
  }
}

export function guideBlobId(bytes: Buffer) {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

export async function readLocalGuideBlob(directory: string, file: string, hash: string, limit: number) {
  try {
    const path = await realpath(directory);
    const bytes = await readResource(path, join(path, file), limit);
    if (guideBlobId(bytes) === hash) return bytes;
  } catch {}
}

export async function verifyGuideSnapshot(directory: string, files: readonly {
  readonly path: string;
  readonly hash: string;
  readonly maxBytes: number;
}[], signal: AbortSignal, onProgress?: ResourceProgressCallback) {
  for (let start = 0; start < files.length; start += 8) {
    signal.throwIfAborted();
    const batch = files.slice(start, start + 8);
    const valid = await Promise.all(batch.map(({ path, hash, maxBytes }) =>
      readLocalGuideBlob(directory, path, hash, maxBytes).then(Boolean)));
    signal.throwIfAborted();
    reportResourceProgress(onProgress, signal, "guides-check", "核对攻略快照", start + batch.length, files.length);
    if (valid.some(result => !result)) return false;
  }
  return true;
}

export async function cleanGuideStages(root: string, prefix: ".refresh-" | ".install-") {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(prefix) && /^[a-z0-9]{6}$/iu.test(entry.name.slice(prefix.length))) {
      await rm(join(root, entry.name), { recursive: true, force: true });
    }
  }
}

function gitOptions(source: string) {
  const protocol = new URL(source).protocol;
  if (protocol !== "https:" && protocol !== "file:") throw new Error("配队资源 Git 协议不受支持。");
  return {
    PATH: process.env.PATH, LC_ALL: "C", GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: protocol.slice(0, -1), GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy,
    ALL_PROXY: process.env.ALL_PROXY, all_proxy: process.env.all_proxy,
    NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy,
  };
}

async function clearGuideGitTransientFiles(directory: string) {
  await Promise.all(["shallow.lock", "FETCH_HEAD.lock", "packed-refs.lock", "config.lock"].map(name => rm(join(directory, name), { force: true })));
  const packDirectory = join(directory, "objects/pack");
  const files = await readdir(packDirectory).catch(() => []);
  await Promise.all(files.filter(name => /^(?:tmp_pack_|tmp_idx_)/u.test(name)).map(name => rm(join(packDirectory, name), { force: true })));
}

function gitClient(directory: string, source: string, signal: AbortSignal, onProgress?: ResourceProgressCallback) {
  const binary = Bun.which("git", { PATH: process.env.PATH });
  if (!binary) throw new Error("下载攻略资源需要 Git。");
  const env = gitOptions(source);
  return async (args: readonly string[], stdin?: Uint8Array, maxBuffer = maxIndex): Promise<Buffer> => {
    const active = args.includes("fetch") ? AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) : signal;
    active.throwIfAborted();
    const child = Bun.spawn([
      binary, "--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`,
      "-c", "credential.helper=", "-c", "http.followRedirects=false", "-c", "http.version=HTTP/1.1",
      "-c", "protocol.version=2", "-c", "transfer.bundleURI=false", ...args,
    ], { cwd: directory, env, stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe", maxBuffer, detached: true });
    const stop = () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {
        try { child.kill("SIGKILL"); } catch { /* Git may have exited. */ }
      }
    };
    active.addEventListener("abort", stop, { once: true });
    const diagnostics = (async () => {
      const reader = child.stderr.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split(/[\r\n]/u);
          pending = lines.pop() ?? "";
          for (const line of lines) if (line.trim()) reportResourceProgress(onProgress, active, "guides-git", line.trim().slice(0, 300));
          if (pending.length > 4096) pending = pending.slice(-4096);
        }
        if (pending.trim()) reportResourceProgress(onProgress, active, "guides-git", pending.trim().slice(0, 300));
      } catch { /* Diagnostics must not affect Git. */ }
      finally { reader.releaseLock(); }
    })();
    try {
      const [output, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited, diagnostics]);
      active.throwIfAborted();
      if (code !== 0 || output.byteLength > maxBuffer) throw new Error(`无法读取上游攻略资源（Git ${args[0]}）。`);
      return Buffer.from(output);
    } catch (error) {
      stop();
      await child.exited;
      throw error;
    } finally {
      active.removeEventListener("abort", stop);
      if (active.aborted) await clearGuideGitTransientFiles(directory);
    }
  };
}

const guideFetchOptions = ["--progress", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-maintenance",
  "--filter=blob:none"] as const;
function fetchGuideObjects(git: ReturnType<typeof gitClient>, arguments_: readonly string[], stdin?: Uint8Array) {
  return git(arguments_, stdin).catch(() => git(arguments_, stdin));
}

export async function prepareGuideSourceGit(directory: string, source: string, signal: AbortSignal, onProgress?: ResourceProgressCallback) {
  reportResourceProgress(onProgress, signal, "guides-git", "同步上游攻略资源索引");
  // Callers hold their refresh lock; retain completed packs, discard interrupted writes.
  await clearGuideGitTransientFiles(directory);
  const git = gitClient(directory, source, signal, onProgress);
  await git(["init", "--quiet", "--bare", "--template="]);
  const remotes = (await git(["remote"])).toString("utf8").trim().split("\n");
  await git(["remote", remotes.includes("origin") ? "set-url" : "add", "origin", source]);
  await git(["config", "remote.origin.promisor", "true"]);
  await git(["config", "remote.origin.partialclonefilter", "blob:none"]);
  await fetchGuideObjects(git, ["fetch", ...guideFetchOptions, "--depth=1", "origin", `+${guideSourceRef}:${guideSourceRef}`]);
  return git;
}

export async function fetchGuideBlobs(git: ReturnType<typeof gitClient>, hashes: Iterable<string>): Promise<void> {
  const wanted = [...new Set(hashes)];
  if (!wanted.length) return;
  // Enumerate only locally stored objects: unlike probing a missing promisor object,
  // --batch-all-objects does not start an implicit network fetch on older Git.
  const stored = await git(["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"], undefined, 16 * 1024 * 1024);
  const available = new Set(stored.toString("utf8").split("\n").flatMap(line => /^([0-9a-f]{40}) blob$/u.exec(line)?.slice(1) ?? []));
  const ids = wanted.filter(hash => !available.has(hash));
  if (!ids.length) return;
  await fetchGuideObjects(git, ["-c", "fetch.negotiationAlgorithm=noop", "fetch", ...guideFetchOptions, "origin", "--stdin"],
    Buffer.from(ids.join("\n") + "\n"));
}

export function createTeamResources(options: {
  readonly root: string;
  readonly fallback: string;
  readonly alternatives?: readonly string[];
  readonly signal?: AbortSignal;
  readonly source?: string;
  readonly onProgress?: ResourceProgressCallback;
  readonly logProgress?: boolean;
}) {
  const { root, fallback } = options;
  const source = options.source ?? guideSource;
  const fallbacks = [fallback, ...(options.alternatives ?? [])];
  const objectDirectory = join(root, "objects");
  const pending = join(root, "pending");
  const checked = join(root, "checked");
  let running: Promise<"current" | "updated"> | undefined;

  async function fallbackDirectory() {
    for (const directory of fallbacks) {
      try {
        const base = await realpath(directory);
        const index = await readResource(base, join(base, indexPath), maxIndex);
        if (indexedTeamImages(index.toString("utf8")).length) return directory;
      } catch {}
    }
  }

  async function download(force: boolean): Promise<"current" | "updated"> {
    const timeout = AbortSignal.timeout(180_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    signal.throwIfAborted();
    const terminal = options.logProgress && !options.onProgress ? createInitializationProgress("配队资源", { signal }) : undefined;
    const onProgress = options.onProgress ?? terminal?.update;
    let succeeded = false;
    const report = (stage: string, message: string, completed?: number, total?: number) =>
      reportResourceProgress(onProgress, signal, stage, message, completed, total);
    report("guides-team", "准备配队资源");
    let lock: Awaited<ReturnType<typeof lockFile>> | undefined;
    let temporary: string | undefined;
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      lock = await lockFile(join(root, "refresh.lock"), "配队资源");
      await cleanGuideStages(root, ".refresh-");
      await writeGuideFile(pending, "");
      temporary = await mkdtemp(join(root, ".refresh-"));
      const gitCache = join(root, "source-git", createHash("sha256").update(source).digest("hex").slice(0, 24));
      await mkdir(gitCache, { recursive: true, mode: 0o700 });
      const git = await prepareGuideSourceGit(gitCache, source, signal, onProgress);
      const currentSourcePath = moraSourcePath(sourcePath);
      const resolveTree = async (path: string) => (await git(["rev-parse", "--verify", `${guideSourceRef}:${path}`])).toString().trim();
      const renamedTree = await resolveTree(currentSourcePath).catch(() => undefined);
      const path = renamedTree ? currentSourcePath : sourcePath;
      const tree = renamedTree ?? await resolveTree(path);
      if (!gitId.test(tree)) throw new Error("上游配队目录无效。");
      const previous = await managedSnapshot(root);
      const objects = readGitTree((await git(["ls-tree", "-r", "-z", guideSourceRef, "--", path])).toString("utf8"), path);
      if (!force && previous?.tree === tree && await verifyGuideSnapshot(previous.directory,
        [...objects].map(([path, hash]) => ({ path, hash, maxBytes: path === indexPath ? maxIndex : maxImage })), signal, onProgress)) {
        await writeGuideFile(checked, "");
        await rm(pending, { force: true });
        succeeded = true;
        return "current";
      }

      const known = new Map<string, Buffer>();
      let total = 0;
      function retain(hash: string, bytes: Buffer) {
        total += bytes.byteLength;
        if (total > maxSnapshot) throw new Error("上游配队文件大小无效。");
        known.set(hash, bytes);
      }
      const localDirectories = previous ? [previous.directory, ...fallbacks] : fallbacks;
      let checkedCount = 0;
      for (const [file, hash] of objects) {
        report("guides-team-check", "核对配队缓存", checkedCount++, objects.size);
        if (known.has(hash)) continue;
        const limit = file === indexPath ? maxIndex : maxImage;
        let bytes = await readLocalGuideBlob(objectDirectory, hash, hash, limit);
        for (const directory of localDirectories) {
          if (bytes) break;
          bytes = await readLocalGuideBlob(directory, file, hash, limit);
        }
        if (bytes) retain(hash, bytes);
      }
      report("guides-team-check", "配队缓存核对完成", objects.size, objects.size);
      const missing = [...new Map([...objects].filter(([, hash]) => !known.has(hash)).map(([file, hash]) => [hash, file]))];
      for (let start = 0; start < missing.length; start += 8) {
        const batch = missing.slice(start, start + 8);
        report("guides-team-download", "下载配队资源", start, missing.length);
        await fetchGuideBlobs(git, batch.map(([hash]) => hash));
        for (const [index, [hash, file]] of batch.entries()) {
          const bytes = await git(["cat-file", "blob", hash], undefined, file === indexPath ? maxIndex : maxImage);
          if (guideBlobId(bytes) !== hash || (file !== indexPath && !bytes.subarray(0, 8).equals(pngHeader))) {
            throw new Error("上游配队文件不完整。");
          }
          signal.throwIfAborted();
          retain(hash, bytes);
          await writeGuideFile(join(objectDirectory, hash), bytes);
          report("guides-team-download", `已取得 ${file}`, start + index + 1, missing.length);
        }
      }
      const index = known.get(objects.get(indexPath)!);
      if (!index || index.byteLength > maxIndex) throw new Error("上游缺少可用的配队索引。");
      const expected = indexedTeamImages(index.toString("utf8"));
      if (!expected.length || expected.some((file) => !objects.has(file))) throw new Error("上游配队索引缺少原图。");

      const stage = join(temporary, "stage");
      let size = 0;
      let publishedCount = 0;
      for (const [file, hash] of objects) {
        const bytes = known.get(hash);
        if (!bytes || (file !== indexPath && !bytes.subarray(0, 8).equals(pngHeader))) throw new Error("上游配队文件不完整。");
        size += bytes.byteLength;
        if (size > maxSnapshot) throw new Error("上游配队文件大小无效。");
        const target = join(stage, file);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: "wx" });
        report("guides-team-install", "保存配队资源", ++publishedCount, objects.size);
      }
      const next = `snapshots/${tree}-${crypto.randomUUID()}`;
      const pointer = join(temporary, "pointer");
      await mkdir(join(root, "snapshots"), { recursive: true });
      await symlink(next, pointer, "dir");
      signal.throwIfAborted();
      await rename(stage, join(root, next));
      await rename(pointer, join(root, "current"));
      await writeGuideFile(checked, "");
      await rm(pending, { force: true });
      succeeded = true;
      return "updated";
    } finally {
      try {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      } finally {
        if (succeeded) terminal?.complete();
        else terminal?.fail(signal.aborted ? "资源准备已中止" : "资源准备失败");
        lock?.close();
      }
    }
  }

  function refresh(force = false): Promise<"current" | "updated"> {
    if (running) {
      return force ? running.then((state) => state === "current" ? refresh(true) : state) : running;
    }
    return running = download(force).finally(() => { running = undefined; });
  }

  return {
    async directory() { return (await managedSnapshot(root))?.directory ?? await fallbackDirectory() ?? fallback; },
    async initialized() {
      if (await Bun.file(pending).exists() || !(await managedSnapshot(root))) return false;
      const stat = await lstat(checked).catch(() => undefined);
      return stat !== undefined && Date.now() - stat.mtimeMs < freshness;
    },
    async available() {
      return (await managedSnapshot(root)) !== undefined || (await fallbackDirectory()) !== undefined;
    },
    refresh,
    async wait() { await running?.catch(() => {}); },
  };
}
