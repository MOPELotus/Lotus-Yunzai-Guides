import { renameSync } from "node:fs";
import { mkdir, realpath, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { guideKey, safeGuideName } from "./role-guide-input.ts";
import { pngHeader, readResource, readResourceSnapshot } from "./team-guides.ts";

export const roleImageLimit = 16 * 1024 * 1024;
export type GuideImage = { readonly source: string; readonly bytes: Buffer };

export function isGuideImage(bytes: Buffer): boolean {
  return bytes.length > 16 && (bytes.subarray(0, 8).equals(pngHeader) ||
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP"));
}

export async function readGuideFile(root: string, file: string, limit: number): Promise<Buffer | undefined> {
  try {
    const base = await realpath(root);
    return await readResource(base, join(base, file), limit);
  } catch {}
}

export async function readGuideImage(root: string, file: string): Promise<Buffer | undefined> {
  return (await readGuideImageSnapshot(root, file))?.bytes;
}

export async function readGuideImageSnapshot(root: string, file: string) {
  try {
    const base = await realpath(root);
    const snapshot = await readResourceSnapshot(base, join(base, file), roleImageLimit);
    if (isGuideImage(snapshot.bytes)) return snapshot;
  } catch {}
}

export async function writeGuideFile(file: string, bytes: string | Uint8Array, canWrite?: () => boolean) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    if (canWrite) {
      // Check the panel session in the same turn that publishes its settings.
      if (!canWrite()) return false;
      renameSync(temporary, file);
    } else {
      await rename(temporary, file);
    }
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}

export function matchesGuideImage(file: string, name: string): boolean {
  if (!safeGuideName(file)) return false;
  const extension = extname(file);
  return /^\.(?:png|jpe?g|webp)$/iu.test(extension) && guideKey(file.slice(0, -extension.length)) === guideKey(name);
}

export async function findGuidePack(root: string | undefined, name: string, suffix = ""): Promise<GuideImage[]> {
  if (!root) return [];
  const result: GuideImage[] = [];
  for (const author of await readdir(root).catch(() => [] as string[])) {
    if (!safeGuideName(author)) continue;
    const directory = join(author, suffix);
    const files = await readdir(join(root, directory)).catch(() => [] as string[]);
    const file = files.find((file) => matchesGuideImage(file, name));
    const bytes = file && await readGuideImage(root, join(directory, file));
    if (bytes) result.push({ source: author, bytes });
  }
  return result;
}
