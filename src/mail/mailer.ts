import type { Config } from "../config.js";
import { log } from "../log.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/** Sends through Resend when RESEND_API_KEY is set; otherwise logs the mail (local work and tests). */
export function createMailer(config: Config): Mailer {
  if (!config.RESEND_API_KEY) {
    if (config.NODE_ENV === "production") log.warn("RESEND_API_KEY is not set: emails are logged, not sent");
    return new LogMailer();
  }
  return new ResendMailer(config.RESEND_API_KEY, config.EMAIL_FROM);
}

export class LogMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
    log.info({ to: mail.to, subject: mail.subject, text: mail.text }, "email (not sent: no RESEND_API_KEY)");
  }
}

class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(mail: Mail): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
    });
    if (!res.ok) throw new Error(`Resend refused the email: ${res.status} ${await res.text()}`);
  }
}
