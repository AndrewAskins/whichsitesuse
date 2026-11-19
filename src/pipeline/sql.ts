import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "sql");
const read = (name: string) => readFileSync(join(dir, name), "utf8");

export const EXTRACT_SQL = read("extract.sql");
export const MEASURE_SQL = read("measure.sql").replace("{{EXTRACT}}", EXTRACT_SQL);
export const LATEST_CRAWL_SQL = read("latest-crawl.sql");
export const LATEST_CRUX_SQL = read("latest-crux.sql");
export const PARTITIONS_SQL = (dataset: string) => read("partitions.sql").replace("{{DATASET}}", dataset);
export const EXPORT_SQL = (uri: string) => read("export.sql").replace("{{URI}}", uri).replace("{{EXTRACT}}", EXTRACT_SQL);
