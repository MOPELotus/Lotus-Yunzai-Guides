import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandReply } from "../../lib/commands.ts";
import { readMigrationSourceFile } from "../../lib/migration-files.ts";
import type { MessageReply } from "../../lib/messages.ts";
import { createRoleGuideCache } from "./role-guide-cache.ts";
import { responseBytes } from "./role-guide-collections.ts";
import { isGuideImage, roleImageLimit } from "./role-image-files.ts";

const source = "https://raw.githubusercontent.com/TsukinaKasumi/StarRail-plugin/308a83d25766d6ba6ac178783649f6ea0413a34e/resources/srsr/";
type Page = readonly [string, string];
type Guide = { readonly title: string; readonly pages: readonly Page[] };
const curves = ["基础属性收益曲线", "生存属性收益曲线", "最优攻击百分比", "减防收益曲线", "减抗收益曲线"];
const paths = ["虚无", "丰饶", "巡猎", "毁灭", "同谐", "存护", "智识"];
const rating = [
  ["角色强度榜", $t("starrail-guide-history.text_0bbea1c6c9")], [$t("starrail-guide-history.text_52ca2629f6"), $t("starrail-guide-history.text_052cbb4f6d")], [$t("starrail-guide-history.text_e0b3c3410b"), $t("starrail-guide-history.text_7fa795b122")], [$t("starrail-guide-history.text_f073298294"), $t("starrail-guide-history.text_7ff6a19b83")],
  ["辅助榜", $t("starrail-guide-history.text_40d33aa115")], [$t("starrail-guide-history.text_f85148a9ad"), $t("starrail-guide-history.text_cbd9667c3f")], [$t("starrail-guide-history.text_daede98817"), $t("starrail-guide-history.text_4262c45dc7")],
] as const;
const floorNumbers = [$t("starrail-guide-history.text_51a75f4634"), $t("starrail-guide-history.text_084b42f6e9"), $t("starrail-guide-history.text_a4c3313deb"), $t("starrail-guide-history.text_754a9d5828"), $t("starrail-guide-history.text_c9b87f516a"), $t("starrail-guide-history.text_de07b53838"), $t("starrail-guide-history.text_1b0542878c"), $t("starrail-guide-history.text_2c467d3673"), $t("starrail-guide-history.text_df897da6e0"), $t("starrail-guide-history.text_fc7edd399a")];
const teams = new Map<number, readonly [string, string, string]>([
  [2, ["丹恒、希儿、青雀", $t("starrail-guide-history.text_18277dfbb0"), $t("starrail-guide-history.text_44835ec157")]],
  [3, ["景元、阿兰、希露瓦、素裳、物主", $t("starrail-guide-history.text_2164d91c5e"), $t("starrail-guide-history.text_5a25c33b0d")]],
  [5, ["彦卿、虎克、希儿", $t("starrail-guide-history.text_4f4b485b38"), $t("starrail-guide-history.text_4773bfcc50")]],
  [6, ["景元、彦卿、阿兰、希露瓦", $t("starrail-guide-history.text_2164d91c5e"), $t("starrail-guide-history.text_9e7526cf5b")]],
  [8, ["彦卿、景元、阿兰", $t("starrail-guide-history.text_2164d91c5e"), $t("starrail-guide-history.text_9e1c20e8f2")]],
  [9, ["景元、彦卿、阿兰、希露瓦", $t("starrail-guide-history.text_2164d91c5e"), $t("starrail-guide-history.text_9e1c20e8f2")]],
  [11, ["彦卿、景元、阿兰", $t("starrail-guide-history.text_2164d91c5e"), $t("starrail-guide-history.text_9e1c20e8f2")]],
  [12, ["丹恒、彦卿、希儿、景元", $t("starrail-guide-history.text_f7fd5247bf"), $t("starrail-guide-history.text_4773bfcc50")]],
  [14, ["希儿、丹恒、青雀", $t("starrail-guide-history.text_f7fd5247bf"), $t("starrail-guide-history.text_4773bfcc50")]],
  [15, ["景元、姬子、虎克、阿兰、希露瓦", $t("starrail-guide-history.text_2c937289ca"), $t("starrail-guide-history.text_015575afbb")]],
  [17, ["素裳、物主、希儿、彦卿", $t("starrail-guide-history.text_cc8be31709"), $t("starrail-guide-history.text_4773bfcc50")]],
  [18, ["景元、彦卿、阿兰、希露瓦", $t("starrail-guide-history.text_f08558a444"), $t("starrail-guide-history.text_f0dbe3b58b")]],
  [20, ["希儿、虎克、青雀", $t("starrail-guide-history.text_6396cef5e4"), $t("starrail-guide-history.text_d9133c032b")]],
  [21, ["景元、彦卿、阿兰、希露瓦", $t("starrail-guide-history.text_1944622d87"), $t("starrail-guide-history.text_c6fdd30a01")]],
  [23, ["希儿、青雀、丹恒", $t("starrail-guide-history.text_6396cef5e4"), $t("starrail-guide-history.text_c209c8bda2")]],
  [24, ["丹恒、素裳", $t("starrail-guide-history.text_db058ae4b6"), $t("starrail-guide-history.text_16ad572213")]],
  [26, ["彦卿、虎克、希儿", $t("starrail-guide-history.text_f85e1d1e2c"), $t("starrail-guide-history.text_c7a27e01cb")]],
  [27, ["景元、阿兰、希露瓦", $t("starrail-guide-history.text_a1a89b8459"), $t("starrail-guide-history.text_b602333661")]],
  [29, ["彦卿、希儿、黑塔、素裳", $t("starrail-guide-history.text_d890759bab"), $t("starrail-guide-history.text_a827ea1dc2")]],
  [30, ["希儿、青雀、景元、虎克", $t("starrail-guide-history.text_b013b7b31c"), $t("starrail-guide-history.text_a2dfe01ee8")]],
]);
const hallPages: Page[] = [["wq/忘却之庭.jpg", $t("starrail-guide-history.text_e0d7f93059")]];
for (let index = 1; index <= 30; index++) {
  const floor = $t("starrail-guide-history.text_37763bb640", { "value1": floorNumbers[Math.floor((index - 1) / 3)] });
  const stage = (index - 1) % 3;
  const recommendation = teams.get(index);
  const heading = floor + (stage === 1 ? $t("starrail-guide-history.text_3401df6359") : stage === 2 ? $t("starrail-guide-history.text_38866b106e") : "");
  hallPages.push([`wq/${index}.jpg`, recommendation
    ? $t("starrail-guide-history.text_8fc7625790", { "heading": heading, "value2": recommendation[0], "value3": recommendation[1], "value4": recommendation[2] }) : heading]);
}
const guide = { title: $t("starrail-guide-history.text_d19403eb2a"), pages: paths.map(path => [`gl/${path}.jpg`, path] as const) };
const ranking = { title: $t("starrail-guide-history.text_b44911ba80"), pages: rating.map(([file, label]) => [`qd/${file}.jpg`, label] as const) };
const hall = { title: $t("starrail-guide-history.text_ee017a9f9a"), pages: hallPages };
const entries = new Map<string, Guide>([
  ["收益曲线", { title: $t("starrail-guide-history.text_821a110caf"), pages: curves.map(name => [`sy/${name}.jpg`, name] as const) }],
  ["强度榜", ranking], ["全角色强度榜", ranking], ["攻略", guide], ["深渊攻略", hall], ["忘却之庭攻略", hall],
  ["商店光锥推荐", { title: $t("starrail-guide-history.text_26d83cf78b"), pages: [["gz/商店光锥推荐.jpg", $t("starrail-guide-history.text_f1963413c6")]] }],
]);

type OriginalGuideOptions = { readonly cache: string; readonly settingsRoot?: URL;
  readonly signal?: AbortSignal; readonly fetch?: typeof fetch };

export function createOriginalStarRailGuideReader(options: OriginalGuideOptions) {
  const { cache, signal } = options;
  const transport = options.fetch ?? fetch;
  const installation = options.settingsRoot && fileURLToPath(options.settingsRoot);
  const oldRoots = installation ? ["plugins", "backup/plugins"].map(path => join(installation, path, "StarRail-plugin/resources/srsr")) : [];
  const cached = createRoleGuideCache({ cache, automatic: false, signal });

  async function original(file: string) {
    if (installation) {
      for (const root of oldRoots) {
        try {
          const stored = await readMigrationSourceFile(installation, join(root, file), roleImageLimit, signal);
          if (stored && isGuideImage(stored.bytes)) return stored.bytes;
        } catch {}
      }
    }
  }

  async function download(file: string) {
    const expiry = AbortSignal.timeout(20_000);
    const active = signal ? AbortSignal.any([expiry, signal]) : expiry;
    const url = new URL(file, source);
    const request = () => transport(url, { signal: active, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    const response = await request().catch(error => {
      active.throwIfAborted();
      if (!(error instanceof TypeError)) throw error;
      return request();
    });
    const bytes = await responseBytes(response, roleImageLimit);
    if (isGuideImage(bytes)) return bytes;
  }

  return (file: string) => /^(?:[a-z]{2}\/)?[\p{L}\p{N}•-]+\.jpg$/u.test(file)
    ? cached(join("sr-history-308a83d", file), false, () => download(file), () => original(file)) : Promise.resolve(undefined);
}

export function createStarRailGuideHistory(options: OriginalGuideOptions) {
  const { signal } = options;
  const read = createOriginalStarRailGuideReader(options);

  async function render({ title, pages }: Guide): Promise<CommandReply | undefined> {
    const nodes: MessageReply[] = [title];
    const missing: string[] = [];
    for (let start = 0; start < pages.length; start += 5) {
      if (signal?.aborted) return;
      const batch = await Promise.all(pages.slice(start, start + 5).map(async ([file, label]) => {
        const bytes = await read(file);
        return { file, label, bytes };
      }));
      for (const { file, label, bytes } of batch) {
        if (bytes) nodes.push([label, { type: "image", file: bytes }]);
        else missing.push(file.slice(file.lastIndexOf("/") + 1));
      }
    }
    if (signal?.aborted) return;
    if (nodes.length === 1) return $t("starrail-guide-history.text_80aa9405b7", { "title": title });
    if (missing.length) nodes.push($t("starrail-guide-history.text_fdacb66105", { "value1": missing.join("、") }));
    return pages.length > 1 ? { type: "forward", nodes, senderName: title, batchSize: 6 }
      : nodes.flat();
  }

  return (message: string) => {
    const command = /^#?星铁(.+)$/u.exec(message)?.[1];
    const selection = command && entries.get(command);
    if (selection) return render(selection);
  };
}
