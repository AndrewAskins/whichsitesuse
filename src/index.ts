import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SnapshotHolder } from "./data/sync.js";
import { log } from "./log.js";

const config = loadConfig();
const snapshots = new SnapshotHolder(config);

const app = createApp({ config, getSnapshot: () => snapshots.get() });
app.listen(config.PORT, () => log.info({ port: config.PORT }, "listening"));
snapshots.start().catch((err) => log.error({ err }, "snapshot failed to load"));
