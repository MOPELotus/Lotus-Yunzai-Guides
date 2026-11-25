import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
// Collection and post selection adapted from Mora-Plugin model/roleGuide.js.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { guideGames, guideKey, safeGuideName, type GuideGame, type GuideRole } from "./role-guide-input.ts";
import { isGuideImage, roleImageLimit } from "./role-image-files.ts";
import { configuredGuideCollection } from "./guide-configuration.ts";

type Author = { readonly source: string; readonly collection_id: readonly number[] };
export type GuideFetch = (url: URL, init: RequestInit) => Promise<Response>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function authors(value: unknown): Author[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error($t("role-guide-collections.text_ddc1f23c7f"));
  return value.map((entry) => {
    const { source, collection_id } = object(entry);
    if (typeof source !== "string" || !safeGuideName(source) || !Array.isArray(collection_id) || collection_id.length > 12) {
      throw new Error($t("role-guide-collections.text_31d2de45f5"));
    }
    const ids = collection_id.map((id) => typeof id === "string" && /^\d+$/u.test(id) ? Number(id) : id);
    if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) throw new Error($t("role-guide-collections.text_845ce94051"));
    return { source, collection_id: ids };
  });
}

export function parseGuideCollections(game: GuideGame, value: unknown) {
  if (game === "gs") {
    const { news, olds } = object(value);
    return { news: authors(news ?? []), olds: authors(olds ?? []) };
  }
  return { news: authors(value), olds: [] };
}

export async function readGuideAuthors(game: GuideGame, root?: string, settingsRoot?: URL) {
  const filename = guideGames[game].config;
  if (settingsRoot) {
    try {
      const configured = await configuredGuideCollection(game, settingsRoot);
      if (configured !== undefined) return parseGuideCollections(game, configured);
    } catch {}
  }
  const parse = (source: string) => parseGuideCollections(game, Bun.YAML.parse(source));
  if (root) {
    try { return parse(await readFile(join(root, filename), "utf8")); } catch {}
  }
  return parse(await readFile(new URL(`./collection-defaults/${filename}`, import.meta.url), "utf8"));
}

export async function responseBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error($t("role-guide-collections.text_69f08d4450"));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) throw new Error($t("role-guide-collections.text_b4ad6e6045"));
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const collectionUrl = "https://bbs-api.mihoyo.com/post/wapi/getPostFullInCollection";
const imageHosts = new Set(["upload-bbs.miyoushe.com", "upload-bbs.mihoyo.com"]);
const legacyImageProcess = "image//resize,s_1200/quality,q_90/auto-orient,0/interlace,1/format,jpg";
const zzzImageProcess = "image/resize,s_1200/quality,q_90/auto-orient,0/interlace,1/format,jpg";
const materialImageProcess = "image//resize,s_1000/quality,q_80/auto-orient,0/interlace,1/format,jpg";

function guidePostImages(post: Record<string, unknown>) {
  const cover = object(post.cover).url;
  return objects(post.image_list).filter(image => typeof image.url === "string" &&
    image.url !== cover && String(image.format).toLowerCase() !== "gif");
}

function selectZzzImage(posts: readonly Record<string, unknown>[], name: string): string | undefined {
  const keyword = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/gu, "");
  if (!keyword) return;
  for (const row of posts) {
    const { subject } = object(row.post);
    if (typeof subject !== "string" || !subject.replace(/【[^】]*本[^】]*】/gu, "").includes(keyword)) continue;
    let largest: { url: string; size: number } | undefined;
    for (const image of guidePostImages(row)) {
      if (typeof image.url !== "string") continue;
      const size = Number(image.size) || 0;
      if (!largest || size >= largest.size) largest = { url: image.url, size };
    }
    if (largest) return largest.url;
  }
}

function selectImage(posts: readonly Record<string, unknown>[], role: GuideRole, structured: boolean, byHeight = false): string | undefined {
  const name = guideKey(role.name);
  const form = byHeight && name.startsWith("开拓者·") ? name.slice(4) : undefined;
  const terms = (role.topicWords ?? []).map(guideKey);
  const otherForms = (role.otherForms ?? []).map(guideKey);
  let topicImage: string | undefined;
  function url(image: Record<string, unknown> | undefined) {
    return typeof image?.url === "string" ? image.url : undefined;
  }
  for (const row of posts) {
    const post = object(row.post);
    const images = guidePostImages(row);
    if (!images.length) continue;
    if (structured) {
      if (typeof post.structured_content !== "string") continue;
      const content = post.structured_content;
      const offset = content.indexOf(role.name + "】");
      if (offset < 0) continue;
      const imageId = /image\\*":\s*\\*"([^"\\]+)/u.exec(content.slice(offset))?.[1];
      const image = url(images.find((entry) => entry.image_id === imageId));
      if (image) return image;
      continue;
    }
    const title = typeof post.subject === "string" ? guideKey(post.subject) : "";
    if (otherForms.some((form) => title.includes(form) || title.includes(form.replace(/·/gu, "")))) continue;
    const dimension = byHeight ? "height" : "size";
    const largest = [...images].sort((a, b) => Number(b[dimension] ?? 0) - Number(a[dimension] ?? 0)).map(url).find(Boolean);
    if (largest && (title.includes(name) || (form && title.includes("开拓者") && title.includes(form)) ||
      terms.some(term => title.includes(term)))) return largest;
    if (!topicImage && !terms.length && objects(row.topics).some((topic) => typeof topic.name === "string" && guideKey(topic.name) === name)) {
      topicImage = largest;
    }
  }
  return topicImage;
}

export function createRoleGuideCollections(options: {
  readonly config?: string;
  readonly settingsRoot?: URL;
  readonly fetch?: GuideFetch;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}) {
  const transport = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  type CollectionRead = { time: number; pending: boolean; posts: Promise<readonly Record<string, unknown>[]> };
  const reads = new Map<string, CollectionRead>();
  function signal(milliseconds: number) {
    const timeout = AbortSignal.timeout(milliseconds);
    return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  }
  async function request(url: URL, timeout: number) {
    const deadline = signal(timeout);
    const send = () => transport(url, { signal: deadline, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    const response = await send().catch((error: unknown) => {
      deadline.throwIfAborted();
      if (!(error instanceof TypeError)) throw error;
      return send();
    });
    return response;
  }
  function posts(id: number, refresh: boolean, gid: "2" | "6" | "8"): Promise<readonly Record<string, unknown>[]> {
    const key = `${gid}/${id}`;
    const existing = reads.get(key);
    if (existing && (existing.pending || (!refresh && now() - existing.time < 120_000))) return existing.posts;
    const url = new URL(collectionUrl);
    url.searchParams.set("gids", gid);
    if (gid !== "8") url.searchParams.set("order_type", "2");
    url.searchParams.set("collection_id", String(id));
    const requestPosts = (async () => {
      const result = object(JSON.parse((await responseBytes(await request(url, 30_000), 24 * 1024 * 1024)).toString("utf8")));
      if (result.retcode !== 0 || !Array.isArray(object(result.data).posts)) throw new Error($t("role-guide-collections.text_4526e13f15"));
      return objects(object(result.data).posts);
    })();
    const reading: CollectionRead = {
      time: now(), pending: true,
      posts: requestPosts.catch(() => {
        if (reads.get(key) === reading) reads.delete(key);
        return [];
      }).finally(() => { reading.pending = false; }),
    };
    reads.set(key, reading);
    if (reads.size > 48) {
      const oldest = reads.keys().next().value;
      if (oldest !== undefined) reads.delete(oldest);
    }
    return reading.posts;
  }

  async function downloadImage(url: string, process?: string): Promise<Buffer | undefined> {
    const source = new URL(url);
    if (source.protocol !== "https:" || source.username || source.password || source.port || !imageHosts.has(source.hostname)) return;
    if (process) source.searchParams.set("x-oss-process", process);
    const bytes = await responseBytes(await request(source, 25_000), roleImageLimit);
    if (isGuideImage(bytes)) return bytes;
  }

  return {
    authors: (game: GuideGame) => readGuideAuthors(game, options.config, options.settingsRoot),
    async image(role: GuideRole, author: Author, refresh = false, numbered?: GuideGame): Promise<Buffer | undefined> {
      try {
        const zzz = numbered === "zzz";
        const gid = zzz ? "8" : numbered === "sr" ? "6" : "2";
        const batches = await Promise.all(author.collection_id.map(id => posts(id, refresh, gid)));
        const postsInOrder = batches.flat();
        const url = zzz ? selectZzzImage(postsInOrder, role.name)
          : selectImage(postsInOrder, role, author.collection_id.includes(341523), numbered === "sr");
        if (url) return await downloadImage(url, zzz ? zzzImageProcess : numbered ? legacyImageProcess : undefined);
      } catch {}
    },
    async materialImage(id: number, name: string, refresh: boolean, field: "image_list" | "post.images", index: number) {
      try {
        for (const row of await posts(id, refresh, "2")) {
          const post = object(row.post);
          if (typeof post.subject !== "string" || !post.subject.includes(name)) continue;
          const url = field === "image_list" ? objects(row.image_list)[index]?.url
            : Array.isArray(post.images) ? post.images[index] : undefined;
          if (typeof url === "string") {
            const bytes = await downloadImage(url, materialImageProcess);
            if (bytes) return bytes;
          }
        }
      } catch {}
    },
  };
}
