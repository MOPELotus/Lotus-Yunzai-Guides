import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Job } from "node-schedule";
import type { CommandModule } from "../../lib/commands.ts";
import type { MessageSegment } from "../../lib/messages.ts";
import { teamGuides } from "./team-guides.ts";
import { createTeamResources } from "./team-resources.ts";
import { createRoleGuides } from "./role-guides.ts";
import { createRoleMaterials } from "./role-materials.ts";
import { createRoleReferences } from "./role-references.ts";
import { createOriginalRoleResources } from "./original-role-resources.ts";
import { createBannerTables } from "./banner-tables.ts";
import { createAbyssReferences } from "./abyss-references.ts";
import { createAkashaAbyss } from "./akasha-abyss.ts";
import { createGenshinCalendar, createStarrailCalendar, createZzzCalendar } from "./calendar.ts";
import { createCalendarSchedule, type CalendarSchedule, type CalendarScheduleOptions } from "./calendar-schedule.ts";
import { guideFlags, readGuidesConfiguration } from "./guide-configuration.ts";

type TeamResources = ReturnType<typeof createTeamResources>;

export function createGuidesModule(options: {
  readonly directory: string;
  readonly forward?: boolean;
  readonly resources?: TeamResources;
  readonly roleGuides?: ReturnType<typeof createRoleGuides>;
  readonly roleMaterials?: ReturnType<typeof createRoleMaterials>;
  readonly roleReferences?: ReturnType<typeof createRoleReferences>;
  readonly starrailCalendar?: ReturnType<typeof createStarrailCalendar>;
  readonly genshinCalendar?: ReturnType<typeof createGenshinCalendar>;
  readonly zzzCalendar?: ReturnType<typeof createZzzCalendar>;
  readonly bannerTables?: ReturnType<typeof createBannerTables>;
  readonly abyssReferences?: ReturnType<typeof createAbyssReferences>;
  readonly akashaAbyss?: ReturnType<typeof createAkashaAbyss>;
}): CommandModule {
  const { resources } = options;
  const refresh = (force: boolean) => async (argument: string, { isMaster }: { isMaster: boolean }) => {
    if (!isMaster) return "只有主人可以更新配队资源。";
    if (argument) return force ? "请发送 #强制更新配队资源。" : "请发送 #更新配队资源。";
    if (!resources) return "当前使用指定的配队资源目录。";
    try {
      const state = await resources.refresh(force);
      return state === "current" ? "配队资源已是最新。" : "配队资源已更新。";
    } catch {
      return await resources.available() ? "配队资源更新失败，仍使用已有资源。" : "配队资源下载失败，请稍后重试。";
    }
  };
  return {
    name: "@lotus-yunzai/guides",
    commands: {
      "#更新配队资源": refresh(false),
      "#强制更新配队资源": refresh(true),
    },
    async fallback(message, { normalizedMessage, isMaster, inlineImageByteLimit }) {
      const command = normalizedMessage || message;
      const calendar = options.genshinCalendar?.(command) ?? options.starrailCalendar?.(command) ?? options.zzzCalendar?.(command);
      if (calendar !== undefined) return calendar;
      const banners = options.bannerTables?.(command);
      if (banners !== undefined) return banners;
      const abyss = options.akashaAbyss?.(command, inlineImageByteLimit) ?? options.abyssReferences?.(command);
      if (abyss !== undefined) return abyss;
      const roleGuide = options.roleReferences?.(command) ?? options.roleGuides?.(command, isMaster);
      if (roleGuide !== undefined) return roleGuide;
      const roleMaterial = options.roleMaterials?.(command, inlineImageByteLimit);
      if (roleMaterial !== undefined) return roleMaterial;
      if (/^#(?:星铁|绝区零)/u.test(command)) return;
      const query = /^#(\S+)配队$/u.exec(command)?.[1];
      if (!query || query.includes("深渊")) return;
      const directory = resources ? await resources.directory() : options.directory;
      return teamGuides(directory, query, options.forward ?? true);
    },
  };
}

export function startTeamResourceRefresh(resources: TeamResources, signal: AbortSignal) {
  return startResourceRefresh(resources, signal, "team", "配队资源");
}

function startResourceRefresh(resources: Pick<TeamResources, "refresh" | "initialized" | "wait">,
  signal: AbortSignal, kind: string, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 60_000;
  let updating = false;
  async function update() {
    if (signal.aborted || updating) return;
    updating = true;
    if (retry) clearTimeout(retry);
    try {
      if (await resources.refresh() === "updated") console.info(`[guides] ${label}已更新。`);
      delay = 60_000;
    } catch (error) {
      if (signal.aborted) return;
      console.warn(`[guides] ${label}更新失败，保留已有资源。`, error instanceof Error ? error.message : "");
      retry = setTimeout(() => { void update(); }, delay);
      retry.unref();
      delay = Math.min(delay * 2, 3_600_000);
    } finally {
      updating = false;
    }
  }
  const job = new Job(`lotus-guides-${kind}-refresh-${crypto.randomUUID()}`, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void update(); }, Math.floor(Math.random() * 3_600_000));
    timer.unref();
  });
  if (!signal.aborted) {
    job.schedule({ rule: "0 0 3 * * *", tz: "Asia/Shanghai" });
    void resources.initialized().catch(() => false).then((ready) => { if (!ready) return update(); });
  }
  const stop = () => {
    job.cancel();
    if (timer) clearTimeout(timer);
    if (retry) clearTimeout(retry);
  };
  signal.addEventListener("abort", stop, { once: true });
  return async () => {
    stop();
    signal.removeEventListener("abort", stop);
    await resources.wait();
  };
}

const legacyDirectory = fileURLToPath(new URL("../../data/guides/Genshin/TeamGuides/", import.meta.url));
const root = fileURLToPath(new URL("../../data/guides/mora/", import.meta.url));

export async function createModule({ signal, lockFile, guidesSchedule }: {
  readonly signal: AbortSignal;
  readonly lockFile: CalendarScheduleOptions["lockFile"];
  readonly guidesSchedule?: {
    register(policy: CalendarSchedule): () => void;
    registerTask: CalendarScheduleOptions["register"];
    targets: CalendarScheduleOptions["targets"];
    whenReady(start: () => void): () => void;
  };
}) {
  const directory = Bun.env.LOTUS_GUIDES_TEAM_DIR?.trim();
  const installation = new URL("../../", import.meta.url);
  const { forward, auto_update: autoUpdate } = guideFlags(await readGuidesConfiguration(installation).catch(() => ({})));
  const controller = new AbortController();
  const refreshSignal = AbortSignal.any([signal, controller.signal]);
  const data = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  const cache = Bun.env.LOTUS_GUIDES_ROLE_DIR?.trim() || data("../../data/guides/roleGuides/");
  const configuredPack = Bun.env.LOTUS_GUIDES_MORA_PACK_DIR?.trim();
  const guideAutomatic = !!guidesSchedule && autoUpdate;
  const guidePack = configuredPack ? [configuredPack] : [data("../../data/guides/mora-plugin-res/"),
    data("../mora-plugin/resources/mora-plugin-res/")];
  const original = createOriginalRoleResources({ root: data("../../data/guides/role-origin/"),
    cache, fallbacks: guidePack, signal: refreshSignal });
  const bannerResources = createOriginalRoleResources({ root: data("../../data/guides/banner-origin/"),
    cache, fallbacks: guidePack, signal: refreshSignal, scope: "banners" });
  const bannerTables = createBannerTables(bannerResources, guidePack, forward);
  const abyssResources = createOriginalRoleResources({ root: data("../../data/guides/abyss-reference-origin/"),
    cache, fallbacks: guidePack, signal: refreshSignal, scope: "abyss" });
  const abyssReferences = createAbyssReferences(abyssResources, guidePack, forward);
  const akashaAbyss = createAkashaAbyss({ signal: refreshSignal, themes: [
    data("../../backup/plugins/mora-plugin/resources/"), data("../mora-plugin/resources/"),
  ] });
  const legacyZzzResources = Bun.env.LOTUS_ZZZ_LEGACY_RESOURCES_DIR?.trim() || data("../ZZZ-Plugin/resources/");
  const guideOptions = {
    cache,
    config: Bun.env.LOTUS_GUIDES_ROLE_CONFIG_DIR?.trim() || data("../../config/guides/"),
    settingsRoot: installation,
    atlas: Bun.env.LOTUS_GUIDES_LEGACY_ATLAS_DIR?.trim() || data("../../data/guides/legacy-atlas/"),
    guidePack,
    guideSnapshot: original.current,
    guideAutomatic,
    legacyStrategies: [data("../../temp/strategy/"), data("../../data/strategy/")],
    legacyStrategySettings: data("../genshin/config/mys.set.yaml"),
    legacyZzzResources,
    legacyZzzRoot: dirname(legacyZzzResources),
    signal: refreshSignal, forward,
  };
  const roleGuides = createRoleGuides(guideOptions);
  const roleMaterials = createRoleMaterials({ cache: data("../../data/guides/material/"),
    legacy: data("../../temp/material/"), signal: refreshSignal });
  const roleReferences = createRoleReferences(guideOptions);
  const starrailCalendar = createStarrailCalendar({ signal: refreshSignal });
  const genshinCalendar = createGenshinCalendar({ signal: refreshSignal });
  const zzzCalendar = createZzzCalendar({ signal: refreshSignal });
  const resources = directory ? undefined : createTeamResources({ root, fallback: legacyDirectory,
    alternatives: guidePack.map(pack => join(pack, "Genshin", "TeamGuides")), signal: refreshSignal });
  const scheduled = guidesSchedule && await createCalendarSchedule({
    signal: refreshSignal, root: installation, lockFile,
    register: guidesSchedule.registerTask, targets: guidesSchedule.targets,
    async render(type, active) {
      const replies = await Promise.all([
        type === "S" ? undefined : createGenshinCalendar({ signal: active })("#日历"),
        type === "G" ? undefined : createStarrailCalendar({ signal: active })("#星铁日历"),
      ]);
      const images = replies.filter((reply): reply is Extract<MessageSegment, { type: "image" }> =>
        typeof reply === "object" && reply !== null && "type" in reply && reply.type === "image" && "file" in reply);
      if (images.length === (type === "*" ? 2 : 1)) return images;
    },
    report(stage, outcome) {
      console.warn(`[guides] 定时日历 ${stage} ${outcome === "unknown" ? "结果待核对" : "失败"}。`);
    },
  });
  const unregister = scheduled && !refreshSignal.aborted ? guidesSchedule?.register(scheduled) : undefined;
  let stop: ReturnType<typeof startTeamResourceRefresh> | undefined;
  let stopOriginal: ReturnType<typeof startResourceRefresh> | undefined;
  let stopBanners: ReturnType<typeof startResourceRefresh> | undefined;
  let stopAbyss: ReturnType<typeof startResourceRefresh> | undefined;
  const cancelStart = guideAutomatic && guidesSchedule?.whenReady(() => {
    if (refreshSignal.aborted) return;
    if (resources) stop = startTeamResourceRefresh(resources, refreshSignal);
    stopOriginal = startResourceRefresh(original, refreshSignal, "role", "角色和进阶攻略资源");
    stopBanners = startResourceRefresh(bannerResources, refreshSignal, "banners", "复刻表资源");
    stopAbyss = startResourceRefresh(abyssResources, refreshSignal, "abyss-reference", "深渊参考图资源");
  });
  return {
    ...createGuidesModule({ directory: directory ?? legacyDirectory, forward, resources, roleGuides, roleReferences, roleMaterials,
      starrailCalendar, genshinCalendar, zzzCalendar, bannerTables, abyssReferences, akashaAbyss }),
    async dispose() {
      controller.abort();
      if (cancelStart) cancelStart();
      unregister?.();
      await scheduled?.stop();
      await stopOriginal?.();
      if (stopBanners) await stopBanners();
      else await bannerResources.wait();
      if (stopAbyss) await stopAbyss();
      else await abyssResources.wait();
      if (stop) await stop();
      else await resources?.wait();
    },
  };
}
