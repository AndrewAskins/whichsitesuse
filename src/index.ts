import { existsSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Snapshot } from "./data/snapshot.js";
import { SNAPSHOT_FILES } from "./data/schema.js";
import { log } from "./log.js";

const config = loadConfig();
let snapshot: Snapshot | null = null;

async function loadSnapshot() {
  if (!existsSync(join(config.SNAPSHOT_DIR, SNAPSHOT_FILES.manifest))) {
    log.warn({ dir: config.SNAPSHOT_DIR }, "no snapshot on disk yet; data tools will answer snapshot_unavailable");
    return;
  }
  snapshot = await Snapshot.open(config.SNAPSHOT_DIR, { serveHttpArchive: config.SERVE_HTTPARCHIVE });
  log.info({ manifest: snapshot.manifest, serveHttpArchive: config.SERVE_HTTPARCHIVE }, "snapshot loaded");
}

const app = createApp({ config, getSnapshot: () => snapshot });
app.listen(config.PORT, () => log.info({ port: config.PORT }, "listening"));
loadSnapshot().catch((err) => log.error({ err }, "snapshot failed to load"));
