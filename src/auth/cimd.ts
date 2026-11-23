import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { Services } from "../services.js";
import { OAuthError, validRedirectUri, type OAuthClient } from "./oauth.js";

/**
 * OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document),
 * which the MCP authorization spec prefers over dynamic registration. The client_id
 * is an https URL, and the document at that URL says the client's name and redirect
 * URIs. Claude ("https://claude.ai/oauth/mcp-oauth-client-metadata"), Claude Code,
 * ChatGPT and VS Code send one when the server advertises support.
 *
 * A fetched document is stored in oauth_clients under its URL, so codes, tokens and
 * connections reference it like any registered client, and is fetched again once its
 * cache lifetime runs out.
 */

const MAX_BYTES = 16 * 1024;
const TIMEOUT_MS = 5000;
const MIN_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 24 * 3600;
const DEFAULT_TTL_SECONDS = 3600;

export interface MetadataResponse {
  status: number;
  cacheControl: string | undefined;
  body: string;
}

/** Fetches a metadata document. Tests and local runs can swap it on Services. */
export type MetadataFetcher = (url: URL) => Promise<MetadataResponse>;

/** An https URL with a path, no credentials, no fragment and the default port. */
export function isMetadataClientId(clientId: string): boolean {
  if (!clientId.startsWith("https://") || clientId.length > 2000) return false;
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && url.pathname !== "/" && !url.hash && !url.username && !url.password && !url.port && !isIP(url.hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

// Addresses a metadata URL may never resolve to, so a client_id can't make us call our own network.
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) {
  blocked.addSubnet(net, bits, "ipv6");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is refused outright: public hosts don't publish them in DNS.
  // (A ::ffff:0:0/96 rule would also match every plain IPv4 address in a BlockList.)
  if (family === 6) return !/^::ffff:/i.test(address) && !blocked.check(address, "ipv6");
  return false;
}

/** DNS lookup that refuses private addresses. Used as the socket's lookup, so the checked address is the one we connect to. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = (addresses as LookupAddress[]).filter((a) => isPublicAddress(a.address));
    if (list.length === 0) return callback(Object.assign(new Error(`${hostname} has no public address`), { code: "EADDRNOTAVAIL" }), "", 0);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

/** https GET with a public-address lookup, a timeout, a size cap and no redirects. */
export const safeFetch: MetadataFetcher = (url) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: "GET", lookup: publicLookup, timeout: TIMEOUT_MS, headers: { accept: "application/json", "user-agent": "WhichSitesUse-OAuth/1.0" } },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error("metadata document is too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const cc = res.headers["cache-control"];
          resolve({ status: res.statusCode ?? 0, cacheControl: Array.isArray(cc) ? cc.join(",") : cc, body: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("metadata document request timed out")));
    req.on("error", reject);
    req.end();
  });

/** Seconds to keep a document: its max-age within 5 minutes and a day, or an hour. */
export function cacheSeconds(cacheControl: string | undefined): number {
  if (!cacheControl) return DEFAULT_TTL_SECONDS;
  if (/\b(no-store|no-cache)\b/i.test(cacheControl)) return MIN_TTL_SECONDS;
  const m = cacheControl.match(/\bmax-age=(\d+)/i);
  if (!m) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Number(m[1])));
}

export interface ClientMetadata {
  client_name: string;
  redirect_uris: string[];
}

/** Checks a fetched document against the spec's rules for this server. */
export function parseMetadataDocument(clientId: string, body: string): ClientMetadata {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new OAuthError("invalid_client", "The client metadata document isn't JSON.", 401);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new OAuthError("invalid_client", "The client metadata document isn't a JSON object.", 401);
  if (doc.client_id !== clientId) throw new OAuthError("invalid_client", "The client metadata document's client_id doesn't match its URL.", 401);
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && validRedirectUri(u))) {
    throw new OAuthError("invalid_client", "The client metadata document needs 1 to 10 https, loopback http, or app-scheme redirect_uris.", 401);
  }
  // A document can't carry a shared secret, and private_key_jwt isn't supported, so only public clients.
  // ChatGPT leaves the method out, which means "none" here.
  const method = doc.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    throw new OAuthError("invalid_client", "Only public clients (token_endpoint_auth_method none) can use a metadata document here.", 401);
  }
  if ("client_secret" in doc || "client_secret_expires_at" in doc) {
    throw new OAuthError("invalid_client", "A client metadata document must not contain a client secret.", 401);
  }
  const host = new URL(clientId).hostname;
  const name = (typeof doc.client_name === "string" ? doc.client_name : "").trim().slice(0, 100) || host;
  return { client_name: name, redirect_uris: uris as string[] };
}

const SELECT = `SELECT client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, metadata_document
                  FROM oauth_clients WHERE client_id = $1`;

/** The stored client for a metadata URL, fetching the document again when its cache time is up. */
export async function resolveMetadataClient(services: Services, clientId: string): Promise<OAuthClient> {
  const { rows } = await services.db.query<OAuthClient & { fresh: boolean }>(
    `SELECT client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, metadata_document,
            coalesce(metadata_expires_at > now(), false) AS fresh
       FROM oauth_clients WHERE client_id = $1`,
    [clientId],
  );
  const stored = rows[0];
  if (stored?.fresh) {
    const { fresh: _fresh, ...client } = stored;
    return client;
  }

  const fetcher = services.fetchClientMetadata ?? safeFetch;
  let res: MetadataResponse;
  try {
    res = await fetcher(new URL(clientId));
  } catch (err) {
    throw new OAuthError("invalid_client", `Couldn't fetch the client metadata document: ${(err as Error).message}.`, 401);
  }
  if (res.status !== 200) throw new OAuthError("invalid_client", `The client metadata document answered ${res.status}.`, 401);
  const meta = parseMetadataDocument(clientId, res.body);
  const ttl = cacheSeconds(res.cacheControl);
  await services.db.query(
    `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, metadata_document, metadata_expires_at)
     VALUES ($1, NULL, $2, $3, 'none', true, now() + make_interval(secs => $4))
     ON CONFLICT (client_id) DO UPDATE
       SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris,
           metadata_document = true, metadata_expires_at = EXCLUDED.metadata_expires_at`,
    [clientId, meta.client_name, meta.redirect_uris, ttl],
  );
  const again = await services.db.query<OAuthClient>(SELECT, [clientId]);
  return again.rows[0]!;
}
