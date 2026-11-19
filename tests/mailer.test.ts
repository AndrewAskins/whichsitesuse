import { describe, expect, it, vi } from "vitest";
import { LogMailer, LoopsMailer, createMailer, type Mail } from "../src/mail/mailer.js";
import { testConfig } from "./helpers/config.js";

const mail: Mail = { to: "ana@acme.com", template: "login", data: { link: "https://x/auth/t" }, subject: "s", text: "t" };

describe("mailer", () => {
  it("logs instead of sending without LOOPS_API_KEY", () => {
    expect(createMailer(testConfig())).toBeInstanceOf(LogMailer);
    expect(createMailer(testConfig({ LOOPS_API_KEY: "k", LOOPS_TEMPLATE_LOGIN: "cm_login" }))).toBeInstanceOf(LoopsMailer);
  });

  it("sends a Loops transactional email with the template id and data variables", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    await new LoopsMailer("loops_key", { login: "cm_login" }, fetcher as unknown as typeof fetch).send(mail);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.loops.so/api/v1/transactional");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer loops_key");
    expect(JSON.parse(init.body as string)).toEqual({ transactionalId: "cm_login", email: "ana@acme.com", dataVariables: { link: "https://x/auth/t" } });
  });

  it("logs a mail whose template id isn't set, and throws when Loops refuses", async () => {
    const fetcher = vi.fn(async () => new Response("bad", { status: 400 }));
    const loops = new LoopsMailer("k", { verify: "cm_verify" }, fetcher as unknown as typeof fetch);
    await loops.send(mail); // no login template: logged
    expect(fetcher).not.toHaveBeenCalled();
    await expect(loops.send({ ...mail, template: "verify" })).rejects.toThrow(/Loops refused the verify email: 400/);
  });
});
