import { join } from "path";
import * as fs from "fs";
import { app } from "electron";
import { logger } from "./logger";

// ─── App config (API keys, preferences) — stored locally, never in git ───────

const CONFIG_PATH = join(app.getPath("userData"), "app-config.json");

export interface AppConfig {
  geminiApiKey?: string;
  openaiApiKey?: string;
  preferredModel?: string;
}

export function loadConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch {
    logger.warn("Failed to read app config, using defaults");
  }
  return {};
}

export function saveConfig(config: AppConfig): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    logger.info("App config saved", { hasGeminiKey: !!config.geminiApiKey });
  } catch (err) {
    logger.error(`Failed to save config: ${err}`);
  }
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
