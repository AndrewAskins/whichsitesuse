import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Storage } from "@google-cloud/storage";
import type { Config } from "../config.js";

/** GCS in the WhichSitesUse project, used only as a short-lived landing spot for BigQuery's export. */
export function gcsClient(config: Config): Storage {
  const key = JSON.parse(config.GOOGLE_APPLICATION_CREDENTIALS_JSON ?? "{}") as { client_email?: string; private_key?: string };
  return new Storage({
    projectId: config.GCP_PROJECT_ID,
    credentials: { client_email: key.client_email, private_key: key.private_key },
  });
}

export function exportPrefix(crawlDate: string): string {
  return `extract/${crawlDate}/`;
}

export async function downloadPrefix(storage: Storage, bucket: string, prefix: string, dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const [files] = await storage.bucket(bucket).getFiles({ prefix });
  const local: string[] = [];
  for (const file of files) {
    const dest = join(dir, basename(file.name));
    await file.download({ destination: dest });
    local.push(dest);
  }
  return local;
}

export async function deletePrefix(storage: Storage, bucket: string, prefix: string): Promise<void> {
  await storage.bucket(bucket).deleteFiles({ prefix, force: true });
}
