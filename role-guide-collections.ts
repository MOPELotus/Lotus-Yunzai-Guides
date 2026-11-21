// Collection and post selection adapted from Mora-Plugin model/roleGuide.js.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { guideGames, guideKey, safeGuideName, type GuideGame, type GuideRole } from "./role-guide-input.ts";
import { isGuideImage, roleImageLimit } from "./role-image-files.ts";

type Author = { readonly source: string; readonly collection_id: readonly number[] };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}

function authors(value: unknown): Author[] {
  if (!Array.isArray(value) || value.length > 12) throw new Error("攻略作者格式无效。");
  return value.map((entry) => {
    const { source, collection_id } = object(entry);
    if (typeof source !== "string" || !safeGuideName(source) || !Array.isArray(collection_id) || collection_id.length > 12) {
      throw new Error("攻略合集格式无效。");
    }
    const ids = collection_id.map((id) => typeof id === "string" && /^\d+$/u.test(id) ? Number(id) : id);
    if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) throw new Error("攻略合集编号无效。");
    return { source, collection_id: ids };
  });
}

async function readAuthors(game: GuideGame, root?: string) {
  const filename = guideGames[game].config;
  function parse(source: string) {
    const yaml = Bun.YAML.parse(source);
    if (game === "gs") {
      const { news, olds } = object(yaml);
      return { news: authors(news ?? []), olds: authors(olds ?? []) };
    }
    return { news: authors(yaml), olds: [] };
  }
  if (root) {
    try { return parse(await readFile(join(root, filename), "utf8")); } catch {}
  }
  return parse(await readFile(new URL(`./collection-defaults/${filename}`, import.meta.url), "utf8"));
}

async function responseBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error("原攻略来源无响应。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) throw new Error("原攻略来源响应超限。");
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

function selectZzzImage(posts: readonly Record<string, unknown>[], name: string): string | undefined {
  const keyword = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/gu, "");
  if (!keyword) return;
  for (const row of posts) {
    const { subject } = object(row.post);
    if (typeof subject !== "string" || !subject.replace(/【[^】]*本[^】]*】/gu, "").includes(keyword)) continue;
    let largest: { url: string; size: number } | undefined;
    for (const image of objects(row.image_list)) {
      if (typeof image.url !== "string" || String(image.format).toLowerCase() === "gif") continue;
      const size = Number(image.size) || 0;
      if (!largest || size >= largest.size) largest = { url: image.url, size };
    }
    if (largest) return largest.url;
  }
}

function selectImage(posts: readonly Record<string, unknown>[], role: GuideRole, structured: boolean): string | undefined {
  const name = guideKey(role.name);
  const terms = (role.topicWords ?? []).map(guideKey);
  const otherForms = (role.otherForms ?? []).map(guideKey);
  let topicImage: string | undefined;
  function url(image: Record<string, unknown> | undefined) {
    return typeof image?.url === "string" ? image.url : undefined;
  }
  for (const row of posts) {
    const post = object(row.post);
    const images = objects(row.image_list);
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
    const largest = [...images].sort((a, b) => Number(b.size ?? 0) - Number(a.size ?? 0)).map(url).find(Boolean);
    if (largest && (title.includes(name) || terms.some((term) => title.includes(term)))) return largest;
    if (!topicImage && !terms.length && objects(row.topics).some((topic) => typeof topic.name === "string" && guideKey(topic.name) === name)) {
      topicImage = largest;
    }
  }
  return topicImage;
}

export function createRoleGuideCollections(options: {
  readonly config?: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}) {
  const transport = options.fetch ?? fetch;
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
  function posts(id: number, refresh: boolean, zzz: boolean): Promise<readonly Record<string, unknown>[]> {
    const gid = zzz ? "8" : "2";
    const key = `${gid}/${id}`;
    const existing = reads.get(key);
    if (existing && (existing.pending || (!refresh && Date.now() - existing.time < 120_000))) return existing.posts;
    const url = new URL(collectionUrl);
    url.searchParams.set("gids", gid);
    if (!zzz) url.searchParams.set("order_type", "2");
    url.searchParams.set("collection_id", String(id));
    const requestPosts = (async () => {
      const result = object(JSON.parse((await responseBytes(await request(url, 30_000), 24 * 1024 * 1024)).toString("utf8")));
      if (result.retcode !== 0 || !Array.isArray(object(result.data).posts)) throw new Error("原攻略合集内容不可用。");
      return objects(object(result.data).posts);
    })();
    const reading: CollectionRead = {
      time: Date.now(), pending: true,
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

  return {
    authors: (game: GuideGame) => readAuthors(game, options.config),
    async image(role: GuideRole, author: Author, refresh = false, numbered?: "gs" | "zzz"): Promise<Buffer | undefined> {
      try {
        const zzz = numbered === "zzz";
        const batches = await Promise.all(author.collection_id.map((id) => posts(id, refresh, zzz)));
        const url = zzz ? selectZzzImage(batches.flat(), role.name) : selectImage(batches.flat(), role, author.collection_id.includes(341523));
        if (!url) return;
        const source = new URL(url);
        if (source.protocol !== "https:" || source.username || source.password || source.port || !imageHosts.has(source.hostname)) return;
        if (numbered) source.searchParams.set("x-oss-process", zzz ? zzzImageProcess : legacyImageProcess);
        const bytes = await responseBytes(await request(source, 25_000), roleImageLimit);
        if (isGuideImage(bytes)) return bytes;
      } catch {}
    },
  };
}
