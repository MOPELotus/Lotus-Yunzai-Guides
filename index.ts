import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("guides", messageCatalog.messages);
import { createGuideResourcePreparation } from "./initialize-resources.ts";
import type { ResourceProgressCallback } from "../../lib/resource-progress.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Job } from "node-schedule";
import type { CommandModule } from "../../lib/commands.ts";
import type { MessageEvent } from "../../lib/messages.ts";
import { teamGuides } from "./team-guides.ts";
import { createTeamResources } from "./team-resources.ts";
import { createRoleGuides } from "./role-guides.ts";
import { createRoleMaterials } from "./role-materials.ts";
import { createRoleReferences } from "./role-references.ts";
import { createOriginalRoleResources } from "./original-role-resources.ts";
import { createBannerTables } from "./banner-tables.ts";
import { createAbyssReferences } from "./abyss-references.ts";
import { createAkashaAbyss } from "./akasha-abyss.ts";
import { createGenshinCalendar, createScheduledCalendarRenderer, createStarrailCalendar, createZzzCalendar } from "./calendar.ts";
import { createCalendarSchedule, type CalendarSchedule, type CalendarScheduleOptions } from "./calendar-schedule.ts";
import { guideFlags, readGuidesConfiguration } from "./guide-configuration.ts";

type TeamResources = ReturnType<typeof createTeamResources>;
type GuideRefreshSource = {
  readonly label: string;
  refresh(force: boolean): Promise<"updated" | "current">;
};

export function createGuidesModule(options: {
  readonly directory: string;
  readonly forward?: boolean;
  readonly resources?: TeamResources;
  readonly refreshSources?: readonly GuideRefreshSource[];
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
    if (!isMaster) return $t("index.text_d3d18d8ca9");
    if (argument) return force ? $t("index.text_eca52768cf") : $t("index.text_987fe894f9");
    if (!resources) return $t("index.text_960d054046");
    try {
      const state = await resources.refresh(force);
      return state === "current" ? $t("index.text_7dfba262c5") : $t("index.text_1c3148c59f");
    } catch {
      return await resources.available() ? $t("index.text_6f4fe1ddfe") : $t("index.text_0cec41db02");
    }
  };
  const refreshAll = async (force: boolean, argument: string, { isMaster, isDelegated, reply }:
    Pick<MessageEvent, "isMaster" | "isDelegated" | "reply">) => {
    if (!isMaster || isDelegated) return $t("index.text_3537c723cd");
    if (argument) return force ? $t("index.text_3a27919142") : $t("index.text_446cfb7df8");
    const sources = options.refreshSources;
    if (!sources?.length) return $t("index.text_c3fe07a2c1");
    try { await reply($t("index.text_a1a5c68299")); } catch {}
    const results: string[] = [];
    for (const source of sources) {
      try {
        results.push(`${source.label}：${await source.refresh(force) === "updated" ? $t("index.text_434203a723") : $t("index.text_4219a7449e")}`);
      } catch {
        results.push($t("index.text_d04679c243", { "label": source.label }));
      }
    }
    return results.join("\n");
  };
  return {
    name: "@lotus-yunzai/guides",
    commands: {
      "#更新配队资源": refresh(false),
      "#强制更新配队资源": refresh(true),
    },
    async fallback(message, context) {
      const { normalizedMessage, isMaster, inlineImageByteLimit } = context;
      const command = (normalizedMessage || message).trim();
      const refresh = /^#(强制)?更新攻略资源(?:\s+(.*))?$/su.exec(command);
      if (refresh) return refreshAll(!!refresh[1], refresh[2] ?? "", context);
      const calendar = options.genshinCalendar?.(command, inlineImageByteLimit) ??
        options.starrailCalendar?.(command, inlineImageByteLimit) ?? options.zzzCalendar?.(command, inlineImageByteLimit);
      if (calendar !== undefined) return calendar;
      const banners = options.bannerTables?.(command);
      if (banners !== undefined) return banners;
      const abyss = options.akashaAbyss?.(command, inlineImageByteLimit) ?? options.abyssReferences?.(command);
      if (abyss !== undefined) return abyss;
      const owner = isMaster && !context.isDelegated;
      const roleGuide = await (options.roleReferences?.(command) ?? options.roleGuides?.(command, owner,
        () => owner && typeof context.user_id === "number" && context.isBotMaster(context.user_id)));
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
  return startResourceRefresh(resources, signal, "team", $t("index.text_5c071b4dbc"));
}

function startResourceRefresh(resources: Pick<TeamResources, "refresh" | "initialized" | "wait">,
  signal: AbortSignal, kind: string, label: string) {
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = 60_000;
  let updating = false;
  async function update() {
    if (signal.aborted || updating) return;
    updating = true;
    if (retry) clearTimeout(retry);
    try {
      if (await resources.refresh() === "updated") console.info($t("index.text_6660325f0e", { "label": label }));
      delay = 60_000;
    } catch (error) {
      if (signal.aborted) return;
      console.warn($t("index.text_8e27ae72b0", { "label": label }), error instanceof Error ? error.message : "");
      retry = setTimeout(() => { void update(); }, delay);
      retry.unref();
      delay = Math.min(delay * 2, 3_600_000);
    } finally {
      updating = false;
    }
  }
  const job = new Job(`lotus-guides-${kind}-refresh-${crypto.randomUUID()}`, () => {
    void update();
  });
  if (!signal.aborted) {
    job.schedule({ rule: kind === "team" ? "0 0 2,14 * * *" : "0 0 5,17 * * *", tz: "Asia/Shanghai" });
    void resources.initialized().catch(() => false).then(ready => {
      if (!ready && !signal.aborted) console.warn($t("index.text_2fac30c3f5", { "label": label }));
    });
  }
  const stop = () => {
    job.cancel();
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

export async function createModule({ signal, lockFile, guidesSchedule, onProgress }: {
  readonly signal: AbortSignal;
  readonly lockFile: CalendarScheduleOptions["lockFile"];
  readonly onProgress?: ResourceProgressCallback;
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
  const guideAutomatic = !!guidesSchedule && autoUpdate;
  const data = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  const { cache, guidePack, original, bannerResources, abyssResources, resources } =
    createGuideResourcePreparation(installation, refreshSignal, onProgress, true);
  const bannerTables = createBannerTables(bannerResources, guidePack, forward);
  const abyssReferences = createAbyssReferences(abyssResources, guidePack, forward);
  const akashaAbyss = createAkashaAbyss({ signal: refreshSignal, themes: [
    data("../../backup/plugins/mora-plugin/resources/"), data("../mora-plugin/resources/"),
  ] });
  const configuredZzzResources = Bun.env.LOTUS_ZZZ_LEGACY_RESOURCES_DIR?.trim();
  const legacyZzzResources = configuredZzzResources || data("../ZZZ-Plugin/resources/");
  const guideOptions = {
    cache,
    config: Bun.env.LOTUS_GUIDES_ROLE_CONFIG_DIR?.trim() || data("../../config/guides/"),
    settingsRoot: installation,
    atlas: Bun.env.LOTUS_GUIDES_LEGACY_ATLAS_DIR?.trim() || data("../../data/guides/legacy-atlas/"),
    guidePack,
    guideSnapshot: original.current,
    guideAutomatic,
    legacyStrategies: [data("../../temp/strategy/"), data("../../data/strategy/")],
    legacyAddOns: data("../../backup/plugins/mora-plugin/data/roleGuides/add_ons/"),
    legacyStrategySettings: data("../genshin/config/mys.set.yaml"),
    legacyZzzResources,
    legacyZzzRoot: dirname(legacyZzzResources),
    archivedZzzResources: configuredZzzResources ? undefined : data("../../backup/plugins/ZZZ-Plugin/resources/"),
    signal: refreshSignal, forward,
  };
  const roleGuides = createRoleGuides(guideOptions);
  const roleMaterials = createRoleMaterials({ cache: data("../../data/guides/material/"),
    legacy: data("../../temp/material/"), signal: refreshSignal });
  const roleReferences = createRoleReferences(guideOptions);
  const starrailCalendar = createStarrailCalendar({ signal: refreshSignal });
  const genshinCalendar = createGenshinCalendar({ signal: refreshSignal });
  const zzzCalendar = createZzzCalendar({ signal: refreshSignal });
  const refreshSources = [
    { label: $t("index.text_628881681e"), refresh: original.refresh },
    ...(resources ? [{ label: $t("index.text_5c071b4dbc"), refresh: resources.refresh }] : []),
    { label: $t("index.text_6a2cf17295"), refresh: bannerResources.refresh },
    { label: $t("index.text_edc455e048"), refresh: abyssResources.refresh },
  ];
  const scheduled = guidesSchedule && await createCalendarSchedule({
    signal: refreshSignal, root: installation, lockFile,
    register: guidesSchedule.registerTask, targets: guidesSchedule.targets,
    render: createScheduledCalendarRenderer({ signal: refreshSignal }),
    report(stage, outcome) {
      console.warn($t("index.text_07354106bb", { "stage": stage, "value2": outcome === "unknown" ? $t("index.text_79989e841c") : $t("index.text_28384d7afd") }));
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
    stopOriginal = startResourceRefresh(original, refreshSignal, "role", $t("index.text_57f45d3948"));
    stopBanners = startResourceRefresh(bannerResources, refreshSignal, "banners", $t("index.text_f24fbb17da"));
    stopAbyss = startResourceRefresh(abyssResources, refreshSignal, "abyss-reference", $t("index.text_d5f66a746a"));
  });
  return {
    ...createGuidesModule({ directory: directory ?? legacyDirectory, forward, resources, refreshSources, roleGuides, roleReferences, roleMaterials,
      starrailCalendar, genshinCalendar, zzzCalendar, bannerTables, abyssReferences, akashaAbyss }),
    async dispose() {
      controller.abort();
      if (cancelStart) cancelStart();
      unregister?.();
      await scheduled?.stop();
      if (stopOriginal) await stopOriginal();
      else await original.wait();
      if (stopBanners) await stopBanners();
      else await bannerResources.wait();
      if (stopAbyss) await stopAbyss();
      else await abyssResources.wait();
      if (stop) await stop();
      else await resources?.wait();
    },
  };
}
