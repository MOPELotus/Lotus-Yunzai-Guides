import { join } from "node:path";
import { readGuideImageSnapshot, writeGuideFile } from "./role-image-files.ts";

const maxImageAge = 24 * 60 * 60_000;
const failedRetry = 5 * 60_000;
const maxRetryEntries = 1024;

export function createRoleGuideCache({ cache, automatic, signal, now = Date.now }: {
  readonly cache: string;
  readonly automatic?: boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}) {
  const retryAt = new Map<string, number>();
  const pending = new Map<string, { readonly forced: boolean; readonly result: Promise<Buffer | undefined> }>();

  async function load(file: string, force: boolean, download: () => Promise<Buffer | undefined>, legacy?: () => Promise<Buffer | undefined>) {
    const local = await readGuideImageSnapshot(cache, file);
    const saved = local?.bytes ?? await legacy?.();
    if (signal?.aborted) return saved;
    if (!force) {
      const time = now();
      const age = local ? time - local.modifiedAt : Infinity;
      if ((saved && !automatic) || (age >= 0 && age < maxImageAge) || (retryAt.get(file) ?? 0) > time) return saved;
    }
    const downloaded = await download().catch(() => undefined);
    if (signal?.aborted) return saved;
    retryAt.delete(file);
    if (downloaded && await writeGuideFile(join(cache, file), downloaded, () => !signal?.aborted).catch(() => false)) {
      return downloaded;
    }
    if (signal?.aborted) return saved;
    retryAt.set(file, now() + failedRetry);
    if (retryAt.size > maxRetryEntries) retryAt.delete(retryAt.keys().next().value!);
    return downloaded ?? saved;
  }

  return function read(file: string, force: boolean, download: () => Promise<Buffer | undefined>, legacy?: () => Promise<Buffer | undefined>) {
    const existing = pending.get(file);
    if (existing && (!force || existing.forced)) return existing.result;
    const result = Promise.resolve(existing?.result).then(() => load(file, force, download, legacy)).finally(() => {
      if (pending.get(file)?.result === result) pending.delete(file);
    });
    pending.set(file, { forced: force, result });
    return result;
  };
}
