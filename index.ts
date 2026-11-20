import { fileURLToPath } from "node:url";
import { Job } from "node-schedule";
import type { CommandModule } from "../../lib/commands.ts";
import type { MessageSegment } from "../../lib/messages.ts";
import { teamGuides } from "./team-guides.ts";
import { createTeamResources } from "./team-resources.ts";
import { createRoleGuides } from "./role-guides.ts";
import { createRoleReferences } from "./role-references.ts";
import { createGenshinCalendar, createStarrailCalendar, createZzzCalendar } from "./calendar.ts";
import { createCalendarSchedule, type CalendarSchedule, type CalendarScheduleOptions } from "./calendar-schedule.ts";

type TeamResources = ReturnType<typeof createTeamResources>;

export function createGuidesModule(options: {
  readonly directory: string;
  readonly forward?: boolean;
  readonly resources?: TeamResources;
  readonly roleGuides?: ReturnType<typeof createRoleGuides>;
  readonly roleReferences?: ReturnType<typeof createRoleReferences>;
  readonly starrailCalendar?: ReturnType<typeof createStarrailCalendar>;
  readonly genshinCalendar?: ReturnType<typeof createGenshinCalendar>;
  readonly zzzCalendar?: ReturnType<typeof createZzzCalendar>;
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
    async fallback(message, { normalizedMessage }) {
      const command = normalizedMessage || message;
      const calendar = options.genshinCalendar?.(command) ?? options.starrailCalendar?.(command) ?? options.zzzCalendar?.(command);
      if (calendar !== undefined) return calendar;
      const roleGuide = options.roleReferences?.(command) ?? options.roleGuides?.(command);
      if (roleGuide !== undefined) return roleGuide;
      if (/^#(?:星铁|绝区零)/u.test(command)) return;
      const query = /^#(\S+)配队$/u.exec(command)?.[1];
      if (!query || query.includes("深渊")) return;
      const directory = resources ? await resources.directory() : options.directory;
      return teamGuides(directory, query, options.forward ?? true);
    },
  };
}

export function startTeamResourceRefresh(resources: TeamResources, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function update() {
    if (signal.aborted) return;
    try {
      if (await resources.refresh() === "updated") console.info("[guides] 配队资源已更新。");
    } catch (error) {
      if (!signal.aborted) console.warn("[guides] 配队资源更新失败，保留已有资源。", error instanceof Error ? error.message : "");
    }
  }
  const job = new Job(`lotus-guides-team-refresh-${crypto.randomUUID()}`, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void update(); }, Math.floor(Math.random() * 3_600_000));
    timer.unref();
  });
  if (!signal.aborted) {
    job.schedule({ rule: "0 0 3 * * *", tz: "Asia/Shanghai" });
    void resources.initialized().then((ready) => { if (!ready) return update(); });
  }
  const stop = () => {
    job.cancel();
    if (timer) clearTimeout(timer);
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
  const forward = Bun.env.LOTUS_GUIDES_FORWARD !== "0";
  const controller = new AbortController();
  const refreshSignal = AbortSignal.any([signal, controller.signal]);
  const data = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  const guideOptions = {
    cache: Bun.env.LOTUS_GUIDES_ROLE_DIR?.trim() || data("../../data/guides/roleGuides/"),
    config: Bun.env.LOTUS_GUIDES_ROLE_CONFIG_DIR?.trim() || data("../../config/guides/"),
    atlas: Bun.env.LOTUS_GUIDES_LEGACY_ATLAS_DIR?.trim() || data("../../data/guides/legacy-atlas/"),
    guidePack: Bun.env.LOTUS_GUIDES_MORA_PACK_DIR?.trim() || data("../../data/guides/mora-plugin-res/"),
    legacyStrategies: [data("../../temp/strategy/"), data("../../data/strategy/")],
    signal: refreshSignal, forward,
  };
  const roleGuides = createRoleGuides(guideOptions);
  const roleReferences = createRoleReferences(guideOptions);
  const starrailCalendar = createStarrailCalendar({ signal: refreshSignal });
  const genshinCalendar = createGenshinCalendar({ signal: refreshSignal });
  const zzzCalendar = createZzzCalendar({ signal: refreshSignal });
  const resources = directory ? undefined : createTeamResources({ root, fallback: legacyDirectory, signal: refreshSignal });
  const scheduled = guidesSchedule && await createCalendarSchedule({
    signal: refreshSignal, root: new URL("../../", import.meta.url), lockFile,
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
  const cancelStart = resources && Bun.env.LOTUS_GUIDES_AUTO_UPDATE !== "0" && guidesSchedule?.whenReady(() => {
    if (!refreshSignal.aborted) stop = startTeamResourceRefresh(resources, refreshSignal);
  });
  return {
    ...createGuidesModule({ directory: directory ?? legacyDirectory, forward, resources, roleGuides, roleReferences, starrailCalendar, genshinCalendar, zzzCalendar }),
    async dispose() {
      controller.abort();
      if (cancelStart) cancelStart();
      unregister?.();
      await scheduled?.stop();
      if (stop) await stop();
      else await resources?.wait();
    },
  };
}
