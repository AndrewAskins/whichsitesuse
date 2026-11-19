import { readFile } from "node:fs/promises";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { SEO_FORMAT_VERSION, type SeoDataset } from "./dataset.js";

/**
 * The SEO dataset on R2, next to the snapshots:
 *   seo/<crawl_date>/dataset.json
 *   seo/current.json -> { "crawl_date": "...", "key": "seo/<crawl_date>/dataset.json" }
 * It has its own pointer so a snapshot can publish before its pages do, and the pages
 * of the previous month keep serving until the new dataset is written.
 */
export const SEO_CURRENT_KEY = "seo/current.json";
export const seoKey = (crawlDate: string) => `seo/${crawlDate}/dataset.json`;

export interface SeoPointer {
  crawl_date: string;
  key: string;
}

const missing = (err: unknown) => (err as { name?: string }).name === "NoSuchKey";

export async function readSeoPointer(s3: S3Client, bucket: string): Promise<SeoPointer | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: SEO_CURRENT_KEY }));
    return JSON.parse(await res.Body!.transformToString()) as SeoPointer;
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

export async function downloadSeoDataset(s3: S3Client, bucket: string, key: string): Promise<SeoDataset | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return parseSeoDataset(await res.Body!.transformToString());
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

export async function uploadSeoDataset(s3: S3Client, bucket: string, data: SeoDataset): Promise<SeoPointer> {
  const key = seoKey(data.crawl_date);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(data), ContentType: "application/json" }));
  const pointer: SeoPointer = { crawl_date: data.crawl_date, key };
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: SEO_CURRENT_KEY, Body: JSON.stringify(pointer), ContentType: "application/json" }));
  return pointer;
}

export function parseSeoDataset(json: string): SeoDataset {
  const data = JSON.parse(json) as SeoDataset;
  if (data.format_version !== SEO_FORMAT_VERSION) {
    throw new Error(`SEO dataset format ${data.format_version} is not supported (expected ${SEO_FORMAT_VERSION})`);
  }
  return data;
}

export async function readSeoDatasetFile(path: string): Promise<SeoDataset> {
  return parseSeoDataset(await readFile(path, "utf8"));
}
