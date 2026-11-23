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
  ["角色强度榜", "角色总表"], ["输出榜T0-1", "输出 T0–T1"], ["输出榜T2", "输出 T2"], ["输出榜T3", "输出 T3"],
  ["辅助榜", "辅助"], ["生存榜", "生存"], ["备注", "说明"],
] as const;
const floorNumbers = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
const teams = new Map<number, readonly [string, string, string]>([
  [2, ["丹恒、希儿、青雀", "银狼、布洛妮娅、艾丝妲、停云", "白露、娜塔莎、火主、杰帕德"]],
  [3, ["景元、阿兰、希露瓦、素裳、物主", "银狼、佩拉、停云、瓦尔特", "杰帕德、火主、三月七、娜塔莎、白露"]],
  [5, ["彦卿、虎克、希儿", "银狼、艾丝妲、停云", "娜塔莎、火主、杰帕德、白露"]],
  [6, ["景元、彦卿、阿兰、希露瓦", "银狼、佩拉、停云、瓦尔特", "杰帕德、白露、火主、娜塔莎"]],
  [8, ["彦卿、景元、阿兰", "银狼、佩拉、停云、瓦尔特", "杰帕德、娜塔莎、白露、三月七"]],
  [9, ["景元、彦卿、阿兰、希露瓦", "银狼、佩拉、停云、瓦尔特", "杰帕德、娜塔莎、白露、三月七"]],
  [11, ["彦卿、景元、阿兰", "银狼、佩拉、停云、瓦尔特", "杰帕德、娜塔莎、白露、三月七"]],
  [12, ["丹恒、彦卿、希儿、景元", "银狼、艾丝妲、布洛妮娅、瓦尔特、停云", "娜塔莎、火主、杰帕德、白露"]],
  [14, ["希儿、丹恒、青雀", "银狼、艾丝妲、布洛妮娅、瓦尔特、停云", "娜塔莎、火主、杰帕德、白露"]],
  [15, ["景元、姬子、虎克、阿兰、希露瓦", "艾丝妲、停云、银狼", "白露、火主、娜塔莎、杰帕德"]],
  [17, ["素裳、物主、希儿、彦卿", "艾丝妲、银狼、瓦尔特、佩拉", "娜塔莎、火主、杰帕德、白露"]],
  [18, ["景元、彦卿、阿兰、希露瓦", "停云、银狼、瓦尔特、佩拉", "白露、杰帕德、娜塔莎"]],
  [20, ["希儿、虎克、青雀", "艾丝妲、银狼、布洛妮娅、停云", "娜塔莎、火主、白露、杰帕德"]],
  [21, ["景元、彦卿、阿兰、希露瓦", "停云、银狼、佩拉、瓦尔特", "杰帕德、白露、娜塔莎、火主"]],
  [23, ["希儿、青雀、丹恒", "艾丝妲、银狼、布洛妮娅、停云", "娜塔莎、白露、杰帕德、火主"]],
  [24, ["丹恒、素裳", "银狼、瓦尔特、布洛妮娅", "火主、杰帕德、娜塔莎、白露"]],
  [26, ["彦卿、虎克、希儿", "银狼、艾丝妲、瓦尔特、停云", "杰帕德、白露、娜塔莎、三月七"]],
  [27, ["景元、阿兰、希露瓦", "停云、银狼、艾丝妲、布洛妮娅、瓦尔特", "火主、白露、杰帕德、娜塔莎"]],
  [29, ["彦卿、希儿、黑塔、素裳", "佩拉、银狼、瓦尔特、停云", "杰帕德、娜塔莎、三月七、白露"]],
  [30, ["希儿、青雀、景元、虎克", "艾丝妲、银狼、停云", "火主、娜塔莎、白露"]],
]);
const hallPages: Page[] = [["wq/忘却之庭.jpg", "忘却之庭"]];
for (let index = 1; index <= 30; index++) {
  const floor = `其${floorNumbers[Math.floor((index - 1) / 3)]}`;
  const stage = (index - 1) % 3;
  const recommendation = teams.get(index);
  const heading = floor + (stage === 1 ? "上半" : stage === 2 ? "下半" : "");
  hallPages.push([`wq/${index}.jpg`, recommendation
    ? `${heading}\n输出 ${recommendation[0]}\n辅助 ${recommendation[1]}\n生存 ${recommendation[2]}` : heading]);
}
const guide = { title: "星铁 1.1 下半全角色攻略（历史资料）", pages: paths.map(path => [`gl/${path}.jpg`, path] as const) };
const ranking = { title: "星铁 1.0 全角色强度榜（历史资料）", pages: rating.map(([file, label]) => [`qd/${file}.jpg`, label] as const) };
const hall = { title: "星铁忘却之庭 1.0 攻略（历史资料）", pages: hallPages };
const entries = new Map<string, Guide>([
  ["收益曲线", { title: "星铁收益曲线（历史资料）", pages: curves.map(name => [`sy/${name}.jpg`, name] as const) }],
  ["强度榜", ranking], ["全角色强度榜", ranking], ["攻略", guide], ["深渊攻略", hall], ["忘却之庭攻略", hall],
  ["商店光锥推荐", { title: "星铁商店光锥推荐（历史资料）", pages: [["gz/商店光锥推荐.jpg", "商店光锥推荐"]] }],
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
    if (nodes.length === 1) return `${title}的原图暂不可用。`;
    if (missing.length) nodes.push(`原图暂缺 ${missing.join("、")}。`);
    return pages.length > 1 ? { type: "forward", nodes, senderName: title, batchSize: 6 }
      : nodes.flat();
  }

  return (message: string) => {
    const command = /^#?星铁(.+)$/u.exec(message)?.[1];
    const selection = command && entries.get(command);
    if (selection) return render(selection);
  };
}
