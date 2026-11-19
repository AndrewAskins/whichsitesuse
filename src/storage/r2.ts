import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Config } from "../config.js";
import { SNAPSHOT_FILES, type SnapshotManifest } from "../data/schema.js";

/**
 * Snapshots on Cloudflare R2 (S3 API). Layout:
 *   snapshots/<crawl_date>/{manifest.json,technologies.parquet,sites.parquet,site_tech.parquet}
 *   snapshots/current.json  -> { "crawl_date": "...", "prefix": "snapshots/<crawl_date>/" }
 * current.json is written last, so readers never see a half-uploaded month.
 */
export interface CurrentPointer {
  crawl_date: string;
  prefix: string;
}

export const CURRENT_KEY = "snapshots/current.json";

const R2_VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;

/** The R2 variables that are unset or blank. */
export function missingR2Vars(config: Config): string[] {
  return R2_VARS.filter((name) => !config[name]?.trim());
}

export function r2Configured(config: Config): boolean {
  return missingR2Vars(config).length === 0;
}

/**
 * Names what is missing and any environment variable names that look like a
 * misspelled R2 key. Names only, never values.
 */
export function r2ConfigError(config: Config, env: NodeJS.ProcessEnv = process.env): Error {
  const missing = missingR2Vars(config);
  const lookalikes = Object.keys(env)
    .filter((k) => /R2|CLOUDFLARE|ACCESS_KEY|SECRET_KEY/i.test(k) && !(R2_VARS as readonly string[]).includes(k))
    .sort();
  const hint = lookalikes.length > 0 ? ` Similar names that are set: ${lookalikes.join(", ")}.` : "";
  return new Error(`R2 is not configured. Missing or blank: ${missing.join(", ")}.${hint}`);
}

export function r2Client(config: Config): S3Client {
  if (!r2Configured(config)) throw r2ConfigError(config);
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.R2_ACCOUNT_ID!.trim()}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.R2_ACCESS_KEY_ID!.trim(), secretAccessKey: config.R2_SECRET_ACCESS_KEY!.trim() },
  });
}

const SNAPSHOT_KEYS = Object.values(SNAPSHOT_FILES);

export async function uploadSnapshot(s3: S3Client, bucket: string, dir: string, manifest: SnapshotManifest): Promise<CurrentPointer> {
  const prefix = `snapshots/${manifest.crawl_date}/`;
  // Parquet first, manifest last, pointer after everything.
  const order = [...SNAPSHOT_KEYS.filter((k) => k !== SNAPSHOT_FILES.manifest), SNAPSHOT_FILES.manifest];
  for (const name of order) {
    await new Upload({
      client: s3,
      params: { Bucket: bucket, Key: prefix + name, Body: createReadStream(join(dir, name)) },
      partSize: 64 * 1024 * 1024,
      queueSize: 4,
    }).done();
  }
  const pointer: CurrentPointer = { crawl_date: manifest.crawl_date, prefix };
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: CURRENT_KEY, Body: JSON.stringify(pointer), ContentType: "application/json" }),
  );
  return pointer;
}

export async function readCurrent(s3: S3Client, bucket: string): Promise<CurrentPointer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: CURRENT_KEY }));
    return JSON.parse(await res.Body!.transformToString()) as CurrentPointer;
  } catch (err) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
}

/** Downloads a snapshot into `dir` atomically: files land in a temp dir that is renamed into place. */
export async function downloadSnapshot(s3: S3Client, bucket: string, pointer: CurrentPointer, dir: string): Promise<void> {
  const tmp = `${dir}.download`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  for (const name of SNAPSHOT_KEYS) {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: pointer.prefix + name }));
    await pipeline(res.Body as Readable, createWriteStream(join(tmp, name)));
  }
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
}

export async function listLocal(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).sort();
}
