// Source and refresh schedule adapted from Mora-Plugin apps/help.js.
import { lstat, mkdir, mkdtemp, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join } from "node:path";
import { lockFile } from "../../lib/file-lock.ts";
import { indexedTeamImages, pngHeader, teamGuideAuthors } from "./team-guides.ts";

export const moraTeamSource = "https://gitee.com/Rrrrrrray/mora-plugin-res.git";
const sourceRef = "refs/heads/master";
const sourcePath = "Genshin/TeamGuides";
const indexPath = "teamGuides.yaml";
const gitId = /^[0-9a-f]{40}$/u;
const snapshotName = /^snapshots\/([0-9a-f]{40})-[0-9a-f-]{36}$/u;
const maxImage = 16 * 1024 * 1024;
const maxIndex = 1024 * 1024;
const maxSnapshot = 128 * 1024 * 1024;

function resourcePaths(file: string): boolean {
  if (file === indexPath) return true;
  const [author, name, ...rest] = file.split("/");
  return !rest.length && teamGuideAuthors.some((item) => item === author) &&
    !!name && !/[\\\u0000-\u001f\u007f]/u.test(name) && name.endsWith(".png");
}

function readGitTree(output: string): Map<string, string> {
  const objects = new Map<string, string>();
  for (const line of output.split("\0")) {
    if (!line) continue;
    const [metadata, source] = line.split("\t", 2);
    if (!source?.startsWith(`${sourcePath}/`)) throw new Error("配队资源路径无效。");
    const file = source.slice(sourcePath.length + 1);
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

function gitClient(directory: string, source: string, signal: AbortSignal) {
  const binary = Bun.which("git");
  if (!binary) throw new Error("下载配队资源需要 Git。");
  const env = gitOptions(source);
  return async (args: readonly string[], stdin?: Uint8Array, maxBuffer = maxIndex): Promise<Buffer> => {
    signal.throwIfAborted();
    const child = Bun.spawn([
      binary, "--no-pager", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`,
      "-c", "credential.helper=", "-c", "http.followRedirects=false", "-c", "http.version=HTTP/1.1",
      "-c", "protocol.version=2", "-c", "transfer.bundleURI=false", ...args,
    ], { cwd: directory, env, stdin: stdin ?? "ignore", stdout: "pipe", stderr: "ignore", maxBuffer, detached: true });
    const stop = () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch {
        try { child.kill("SIGKILL"); } catch { /* Git may have exited. */ }
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const [output, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
      signal.throwIfAborted();
      if (code !== 0 || output.byteLength > maxBuffer) throw new Error(`无法读取上游配队资源（Git ${args[0]}）。`);
      return Buffer.from(output);
    } catch (error) {
      stop();
      await child.exited;
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
    }
  };
}

export function createTeamResources(options: {
  readonly root: string;
  readonly fallback: string;
  readonly signal?: AbortSignal;
  readonly source?: string;
}) {
  const { root, fallback } = options;
  const source = options.source ?? moraTeamSource;
  let running: Promise<"current" | "updated"> | undefined;

  async function download(force: boolean): Promise<"current" | "updated"> {
    const timeout = AbortSignal.timeout(180_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    signal.throwIfAborted();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lock = await lockFile(join(root, "refresh.lock"), "配队资源");
    let temporary: string | undefined;
    try {
      temporary = await mkdtemp(join(root, ".refresh-"));
      const git = gitClient(temporary, source, signal);
      await git(["init", "--quiet", "--bare", "--template="]);
      await git(["remote", "add", "origin", source]);
      await git(["config", "remote.origin.promisor", "true"]);
      await git(["config", "remote.origin.partialclonefilter", "blob:none"]);
      const fetch = ["--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-maintenance",
        "--filter=blob:none"];
      await git(["fetch", ...fetch, "--depth=1", "origin", `${sourceRef}:${sourceRef}`]);
      const tree = (await git(["rev-parse", "--verify", `${sourceRef}:${sourcePath}`])).toString().trim();
      if (!gitId.test(tree)) throw new Error("上游配队目录无效。");
      if (!force && (await managedSnapshot(root))?.tree === tree) return "current";

      const objects = readGitTree((await git(["ls-tree", "-r", "-z", sourceRef, "--", sourcePath])).toString("utf8"));
      const ids = [...new Set(objects.values())];
      await git(["-c", "fetch.negotiationAlgorithm=noop", "fetch", ...fetch, "origin", "--stdin"],
        Buffer.from(ids.join("\n") + "\n"));
      const paths = new Map<string, Buffer>();
      let total = 0;
      for (const [file, hash] of objects) {
        const limit = file === indexPath ? maxIndex : maxImage;
        const size = Number((await git(["cat-file", "-s", hash])).toString().trim());
        if (!Number.isSafeInteger(size) || size < 1 || size > limit || total + size > maxSnapshot) {
          throw new Error("上游配队文件大小无效。");
        }
        const bytes = await git(["cat-file", "blob", hash], undefined, limit);
        if (size !== bytes.byteLength || (file !== indexPath && !bytes.subarray(0, 8).equals(pngHeader))) {
          throw new Error("上游配队文件不完整。");
        }
        total += size;
        paths.set(file, bytes);
      }
      const index = paths.get(indexPath);
      if (!index) throw new Error("上游缺少配队索引。");
      const expected = indexedTeamImages(index.toString("utf8"));
      if (!expected.length || expected.some((file) => !paths.has(file))) throw new Error("上游配队索引缺少原图。");

      const stage = join(temporary, "stage");
      for (const [file, bytes] of paths) {
        const target = join(stage, file);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: "wx" });
      }
      const next = `snapshots/${tree}-${crypto.randomUUID()}`;
      const pointer = join(temporary, "pointer");
      await mkdir(join(root, "snapshots"), { recursive: true });
      await symlink(next, pointer, "dir");
      signal.throwIfAborted();
      await rename(stage, join(root, next));
      await rename(pointer, join(root, "current"));
      return "updated";
    } finally {
      try {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      } finally {
        lock.close();
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
    async directory() { return (await managedSnapshot(root))?.directory ?? fallback; },
    async initialized() { return (await managedSnapshot(root)) !== undefined; },
    async available() {
      return (await managedSnapshot(root)) !== undefined || await Bun.file(join(fallback, indexPath)).exists();
    },
    refresh,
    async wait() { await running?.catch(() => {}); },
  };
}
