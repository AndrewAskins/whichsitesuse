import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { Express } from "express";

export async function listen(app: Express): Promise<{ server: Server; base: string }> {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** A tiny cookie-keeping client for the server-rendered pages. */
export class Browser {
  private cookies = new Map<string, string>();
  constructor(
    private readonly base: string,
    private readonly ip = "203.0.113.7",
  ) {}

  async get(path: string) {
    return this.request(path, { method: "GET" });
  }

  /** Posts a form, adding the CSRF token from `formPage` (fetched first). */
  async post(path: string, fields: Record<string, string>, formPage = path) {
    const csrf = await this.csrf(formPage);
    return this.request(path, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, ...fields }).toString(),
    });
  }

  async csrf(pagePath: string): Promise<string> {
    const res = await this.get(pagePath);
    const match = (await res.text()).match(/name="csrf" value="([^"]+)"/);
    if (!match) throw new Error(`No CSRF field on ${pagePath} (status ${res.status})`);
    return match[1]!;
  }

  async request(path: string, init: RequestInit) {
    const res = await fetch(this.base + path, {
      ...init,
      redirect: "manual",
      headers: {
        ...(init.headers as Record<string, string>),
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        "x-forwarded-for": this.ip,
      },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair!.split("=");
      const value = v.join("=");
      if (value) this.cookies.set(k!.trim(), value);
      else this.cookies.delete(k!.trim());
    }
    return res;
  }
}
