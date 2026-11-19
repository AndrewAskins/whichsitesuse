import { pino } from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "whichsitesuse" },
  redact: ["req.headers.authorization", "*.apiKey", "*.token"],
});
