import { fileURLToPath } from "node:url";
import { readMigrationSourceFile } from "../../lib/migration-files.ts";
import type { GuideGame } from "./role-guide-input.ts";

const installation = new URL("../../", import.meta.url);

export const guideCollectionKeys = { gs: "gs_collections", sr: "sr_collections", zzz: "zzz_collections" } as const;

export function guideFlags(config: Readonly<Record<string, unknown>>) {
  return {
    forward: typeof config.forward === "boolean" ? config.forward : Bun.env.LOTUS_GUIDES_FORWARD !== "0",
    auto_update: typeof config.auto_update === "boolean" ? config.auto_update : Bun.env.LOTUS_GUIDES_AUTO_UPDATE !== "0",
  };
}

export async function readGuidesConfiguration(root = installation): Promise<Record<string, unknown>> {
  const file = fileURLToPath(new URL("config/guides.yaml", root));
  const input = await readMigrationSourceFile(fileURLToPath(root), file, 64 * 1024);
  if (!input) return {};
  const config = Bun.YAML.parse(input.bytes.toString("utf8"));
  if (config === null || config === undefined) return {};
  if (typeof config !== "object" || Array.isArray(config)) throw new TypeError("攻略配置须为 YAML 映射。");
  return config as Record<string, unknown>;
}

export async function configuredGuideCollection(game: GuideGame, root: URL) {
  return (await readGuidesConfiguration(root))[guideCollectionKeys[game]];
}

export class GuideSettingsError extends Error {
  constructor(readonly code: "input" | "conflict" | "permission") {
    super(code);
  }
}
