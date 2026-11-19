import { fileURLToPath } from "node:url";
import type { CommandModule } from "../../lib/commands.ts";
import { teamGuides } from "./team-guides.ts";

export function createGuidesModule(options: {
  readonly directory: string;
  readonly forward?: boolean;
}): CommandModule {
  return {
    name: "@lotus-yunzai/guides",
    commands: {},
    fallback(message, { normalizedMessage }) {
      const command = normalizedMessage || message;
      if (/^#(?:星铁|绝区零)/u.test(command)) return;
      const query = /^#(\S+)配队$/u.exec(command)?.[1];
      if (!query || query.includes("深渊")) return;
      return teamGuides(options.directory, query, options.forward ?? true);
    },
  };
}

export default createGuidesModule({
  directory: Bun.env.LOTUS_GUIDES_TEAM_DIR?.trim() ||
    fileURLToPath(new URL("../../data/guides/Genshin/TeamGuides/", import.meta.url)),
  forward: Bun.env.LOTUS_GUIDES_FORWARD !== "0",
});
