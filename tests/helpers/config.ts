import { loadConfig, type Config } from "../../src/config.js";

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: "test", LOG_LEVEL: "fatal", ...overrides });
}
