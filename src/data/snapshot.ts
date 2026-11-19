import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import { SNAPSHOT_FILES, SNAPSHOT_FORMAT_VERSION, type SnapshotManifest } from "./schema.js";

export type Row = Record<string, unknown>;

/**
 * A read-only view of one monthly snapshot, queried with DuckDB straight from
 * the Parquet files. The kill switch is applied here, in the views, so no
 * query can reach HTTP Archive rows once it is off.
 */
export class Snapshot {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
    readonly manifest: SnapshotManifest,
  ) {}

  static async open(dir: string, opts: { serveHttpArchive: boolean }): Promise<Snapshot> {
    const manifest = JSON.parse(
      await readFile(join(dir, SNAPSHOT_FILES.manifest), "utf8"),
    ) as SnapshotManifest;
    if (manifest.format_version !== SNAPSHOT_FORMAT_VERSION) {
      throw new Error(
        `Snapshot format ${manifest.format_version} is not supported (expected ${SNAPSHOT_FORMAT_VERSION})`,
      );
    }

    const instance = await DuckDBInstance.create(":memory:", { threads: "4" });
    const conn = await instance.connect();
    const file = (name: string) => `'${join(dir, name).replaceAll("'", "''")}'`;
    const sourceFilter = opts.serveHttpArchive ? "" : "WHERE source <> 'httparchive'";

    await conn.run(
      `CREATE VIEW technologies AS SELECT * FROM read_parquet(${file(SNAPSHOT_FILES.technologies)})`,
    );
    await conn.run(
      `CREATE VIEW sites AS SELECT * FROM read_parquet(${file(SNAPSHOT_FILES.sites)}) ${sourceFilter}`,
    );
    await conn.run(
      `CREATE VIEW site_tech AS SELECT * FROM read_parquet(${file(SNAPSHOT_FILES.siteTech)}) ${sourceFilter}`,
    );
    return new Snapshot(instance, conn, manifest);
  }

  async query<T = Row>(sql: string, params: DuckDBValue[] = []): Promise<T[]> {
    const reader = await this.conn.runAndReadAll(sql, params);
    return reader.getRowObjectsJson() as T[];
  }

  close(): void {
    this.conn.closeSync();
    this.instance.closeSync();
  }
}
