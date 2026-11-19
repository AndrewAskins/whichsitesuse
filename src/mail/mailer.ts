import type { Config } from "../config.js";
import { log } from "../log.js";

/**
 * Every email the app sends. Each one is a Loops transactional template; its
 * id is the config value named here, and `data` fills the template's data
 * variables (same names in Loops). README lists the templates to create.
 */
export const TEMPLATES = {
  verify: { config: "LOOPS_TEMPLATE_VERIFY", variables: ["link"] },
  login: { config: "LOOPS_TEMPLATE_LOGIN", variables: ["link"] },
  creditsApproved: { config: "LOOPS_TEMPLATE_CREDITS_APPROVED", variables: ["credits", "accountUrl"] },
  creditsDenied: { config: "LOOPS_TEMPLATE_CREDITS_DENIED", variables: ["accountUrl"] },
  adminAlert: { config: "LOOPS_TEMPLATE_ADMIN_ALERT", variables: ["subject", "text"] },
} as const satisfies Record<string, { config: keyof Config; variables: readonly string[] }>;

export type TemplateName = keyof typeof TEMPLATES;

export interface Mail {
  to: string;
  template: TemplateName;
  data: Record<string, string | number>;
  /** Plain-text version, used when the mail is only logged (no LOOPS_API_KEY) and in tests. */
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Sends through Loops when LOOPS_API_KEY is set; otherwise logs the mail (local work and tests). */
export function createMailer(config: Config): Mailer {
  if (!config.LOOPS_API_KEY) {
    if (config.NODE_ENV === "production") log.warn("LOOPS_API_KEY is not set: emails are logged, not sent");
    return new LogMailer();
  }
  const ids: Partial<Record<TemplateName, string>> = {};
  for (const [name, t] of Object.entries(TEMPLATES) as [TemplateName, (typeof TEMPLATES)[TemplateName]][]) {
    const id = (config[t.config] as string | undefined)?.trim();
    if (id) ids[name] = id;
    else log.warn({ env: t.config }, "Loops template id not set: that email will be logged, not sent");
  }
  return new LoopsMailer(config.LOOPS_API_KEY, ids);
}

export class LogMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
    log.info({ to: mail.to, template: mail.template, subject: mail.subject, text: mail.text }, "email (logged, not sent)");
  }
}

/** Loops' transactional API: https://loops.so/docs/api-reference/send-transactional-email */
export class LoopsMailer implements Mailer {
  private readonly fallback = new LogMailer();

  constructor(
    private readonly apiKey: string,
    private readonly templateIds: Partial<Record<TemplateName, string>>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async send(mail: Mail): Promise<void> {
    const transactionalId = this.templateIds[mail.template];
    if (!transactionalId) return this.fallback.send(mail);
    const res = await this.fetcher("https://app.loops.so/api/v1/transactional", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ transactionalId, email: mail.to, dataVariables: mail.data }),
    });
    if (!res.ok) throw new Error(`Loops refused the ${mail.template} email: ${res.status} ${await res.text()}`);
  }
}
