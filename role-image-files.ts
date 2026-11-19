import { mkdir, realpath, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { guideKey, safeGuideName } from "./role-guide-input.ts";
import { pngHeader, readResource } from "./team-guides.ts";

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
  const bytes = await readGuideFile(root, file, roleImageLimit);
  if (bytes && isGuideImage(bytes)) return bytes;
}

export async function writeGuideFile(file: string, bytes: string | Uint8Array) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + "." + crypto.randomUUID() + ".tmp";
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, file);
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
