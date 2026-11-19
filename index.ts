import { fileURLToPath } from "node:url";
import { Job } from "node-schedule";
import type { CommandModule } from "../../lib/commands.ts";
import { teamGuides } from "./team-guides.ts";
import { createTeamResources } from "./team-resources.ts";

type TeamResources = ReturnType<typeof createTeamResources>;

export function createGuidesModule(options: {
  readonly directory: string;
  readonly forward?: boolean;
  readonly resources?: TeamResources;
}): CommandModule {
  const { resources } = options;
  const refresh = (force: boolean) => async (argument: string, { isMaster }: { isMaster: boolean }) => {
    if (!isMaster) return "只有主人可以更新摩拉资源。";
    if (argument) return force ? "请发送 #强制更新摩拉资源。" : "请发送 #更新摩拉资源。";
    if (!resources) return "当前使用指定的配队资源目录。";
    try {
      const state = await resources.refresh(force);
      return state === "current" ? "摩拉配队资源已是最新。" : "摩拉配队资源已更新。";
    } catch {
      return await resources.available() ? "摩拉配队资源更新失败，仍使用已有资源。" : "摩拉配队资源下载失败，请稍后重试。";
    }
  };
  return {
    name: "@lotus-yunzai/guides",
    commands: {
      "#更新摩拉资源": refresh(false),
      "#强制更新摩拉资源": refresh(true),
    },
    async fallback(message, { normalizedMessage }) {
      const command = normalizedMessage || message;
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
      if (await resources.refresh() === "updated") console.info("[guides] 摩拉配队资源已更新。");
    } catch (error) {
      if (!signal.aborted) console.warn("[guides] 摩拉配队资源更新失败，保留已有资源。", error instanceof Error ? error.message : "");
    }
  }
  const job = new Job(`lotus-guides-mora-${crypto.randomUUID()}`, () => {
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

export function createModule({ signal }: { signal: AbortSignal }) {
  const directory = Bun.env.LOTUS_GUIDES_TEAM_DIR?.trim();
  const forward = Bun.env.LOTUS_GUIDES_FORWARD !== "0";
  if (directory) return createGuidesModule({ directory, forward });
  const controller = new AbortController();
  const refreshSignal = AbortSignal.any([signal, controller.signal]);
  const resources = createTeamResources({ root, fallback: legacyDirectory, signal: refreshSignal });
  const stop = Bun.env.LOTUS_GUIDES_AUTO_UPDATE === "0" ? undefined : startTeamResourceRefresh(resources, refreshSignal);
  return {
    ...createGuidesModule({ directory: legacyDirectory, forward, resources }),
    async dispose() {
      controller.abort();
      if (stop) await stop();
      else await resources.wait();
    },
  };
}
