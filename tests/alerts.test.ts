import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { alertAdmin, checkGrantAlerts, recordSignal } from "../src/abuse/alerts.js";
import {
  grantConversion,
  grantsPerDay,
  loadDashboard,
  pendingRequestCount,
  recentAlerts,
  recentSignals,
  topNetworks,
  topTrialSpenders,
} from "../src/abuse/stats.js";
import type { Mail, Mailer } from "../src/mail/mailer.js";
import type { Services } from "../src/services.js";
import { createTestDb, makeAccount, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";

let t: TestDb;
let services: Services;
let n = 0;

/** A grant row for a fresh account, `daysAgo` days back. */
async function grant(status: "granted" | "withheld" | "manual" | "revoked", ipPrefix: string | null, daysAgo = 0) {
  const { account } = await makeAccount(services, `user${++n}@grants${n}.test`);
  await services.db.query(
    `INSERT INTO free_grants (account_id, email_normalized, status, credits, ip_prefix, created_at)
     VALUES ($1, $2, $3, $4, $5, now() - make_interval(days => $6))`,
    [account.id, account.email_normalized, status, status === "withheld" ? 0 : 250, ipPrefix, daysAgo],
  );
  return account;
}

async function reset() {
  await services.db.query(
    `TRUNCATE free_grants, abuse_signals, admin_alerts, free_credit_requests, usage_events, credit_ledger, credit_lots, api_keys, accounts CASCADE`,
  );
  t.mailer.sent.length = 0;
}

describe.skipIf(!TEST_DATABASE_URL)("abuse alerts", () => {
  beforeAll(async () => {
    t = await createTestDb({ config: { ADMIN_ALERT_EMAIL: "alerts@example.com", ALERT_GRANTS_PER_DAY: "2" } });
    services = t.services;
  });
  afterAll(async () => t?.drop());
  beforeEach(reset);

  it("records a signal, masking the network", async () => {
    const { account } = await makeAccount(services, "sig@example.com");
    await recordSignal(services, {
      accountId: account.id,
      kind: "grant_withheld_network",
      ip: "203.0.113.9",
      ipPrefix: "203.0.113.9/24",
      emailDomain: "example.com",
      detail: { grants: 3 },
    });
    const [s] = await recentSignals(services.db);
    expect(s).toMatchObject({ kind: "grant_withheld_network", email: "sig@example.com", ip: "203.0.113.9", ip_prefix: "203.0.113.0/24", detail: { grants: 3 } });
  });

  it("sends an alert once per dedupe key, and survives a failing mailer", async () => {
    expect(await alertAdmin(services, "test", "k1", "Subject", "Body")).toBe(true);
    expect(await alertAdmin(services, "test", "k1", "Subject", "Body")).toBe(false);
    expect(t.mailer.sent).toHaveLength(1);
    expect(t.mailer.sent[0]).toMatchObject({ to: "alerts@example.com", text: "Body" });

    const broken: Mailer = { send: async (_m: Mail) => Promise.reject(new Error("down")) };
    expect(await alertAdmin({ ...services, mailer: broken }, "test", "k2", "S", "B")).toBe(true);
    expect((await recentAlerts(services.db)).map((a) => a.dedupe_key)).toEqual(["k2", "k1"]);
  });

  it("records without emailing when ADMIN_ALERT_EMAIL is unset", async () => {
    const quiet = { ...services, config: { ...services.config, ADMIN_ALERT_EMAIL: undefined } };
    expect(await alertAdmin(quiet, "test", "k3", "S", "B")).toBe(true);
    expect(t.mailer.sent).toHaveLength(0);
  });

  it("alerts once a day when grants pass the daily threshold", async () => {
    await grant("granted", null);
    await grant("granted", null);
    await grant("withheld", null); // withheld rows don't count toward the daily threshold
    await checkGrantAlerts(services, null);
    expect(t.mailer.sent).toHaveLength(0);

    await grant("granted", null);
    await checkGrantAlerts(services, null);
    await grant("granted", null);
    await checkGrantAlerts(services, null);
    expect(t.mailer.sent).toHaveLength(1);
    expect(t.mailer.sent[0]!.subject).toMatch(/3 free grants today/);
    const [a] = await recentAlerts(services.db);
    expect(a!.dedupe_key).toBe(`grants-per-day:${new Date().toISOString().slice(0, 10)}`);
  });

  it("alerts once per network when it passes two grant rows in the window", async () => {
    const networkMails = () => t.mailer.sent.filter((m) => /sign-ups from/.test(m.subject));
    await grant("granted", "198.51.100.0/24");
    await grant("granted", "198.51.100.0/24");
    await grant("granted", "198.51.100.0/24", 10); // outside the 7-day window
    await checkGrantAlerts(services, "198.51.100.0/24");
    expect(networkMails()).toHaveLength(0);

    await grant("withheld", "198.51.100.0/24");
    await checkGrantAlerts(services, "198.51.100.77/24");
    await checkGrantAlerts(services, "198.51.100.0/24");
    expect(networkMails()).toHaveLength(1);
    expect(networkMails()[0]!.subject).toMatch(/3 free-grant sign-ups from 198\.51\.100\.0\/24/);

    // Another network has its own alert.
    for (let i = 0; i < 3; i++) await grant("granted", "192.0.2.0/24");
    await checkGrantAlerts(services, "192.0.2.0/24");
    expect(networkMails()).toHaveLength(2);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("abuse stats", () => {
  beforeAll(async () => {
    t = await createTestDb();
    services = t.services;
  });
  afterAll(async () => t?.drop());
  beforeEach(reset);

  it("counts grants per day by status, with empty days", async () => {
    await grant("granted", null);
    await grant("withheld", null);
    await grant("manual", null, 1);
    await grant("revoked", null, 1);
    await grant("granted", null, 20); // past the 14 days
    const days = await grantsPerDay(services.db);
    expect(days).toHaveLength(14);
    expect(days[0]).toMatchObject({ granted: 1, withheld: 1, manual: 0, revoked: 0 });
    expect(days[1]).toMatchObject({ granted: 0, withheld: 0, manual: 1, revoked: 1 });
    expect(days.slice(2).every((d) => d.granted + d.manual + d.withheld + d.revoked === 0)).toBe(true);
  });

  it("measures grant-to-paid conversion over granted and manual grants", async () => {
    const a = await grant("granted", null);
    await grant("granted", null);
    const m = await grant("manual", null);
    await grant("withheld", null);
    await grant("granted", null, 40);
    await services.db.query("UPDATE accounts SET first_paid_at = now() WHERE id = ANY($1)", [[a.id, m.id]]);
    expect(await grantConversion(services.db)).toEqual({ granted: 3, paid: 2, rate: 2 / 3 });
  });

  it("ranks networks by grant rows in the last week", async () => {
    await grant("granted", "198.51.100.0/24");
    await grant("withheld", "198.51.100.0/24");
    await grant("withheld", "198.51.100.0/24");
    await grant("granted", "192.0.2.0/24");
    await grant("granted", "203.0.113.0/24", 8);
    const nets = await topNetworks(services.db);
    expect(nets.map((r) => [r.network, r.grants, r.granted, r.withheld])).toEqual([
      ["198.51.100.0/24", 3, 1, 2],
      ["192.0.2.0/24", 1, 1, 0],
    ]);
  });

  it("lists top trial spenders with their balance, leaving out paid accounts", async () => {
    const trial = await makeAccount(services, "trial@example.com", { credits: 250, bucket: "trial" });
    const paid = await makeAccount(services, "paid@example.com", { credits: 500, paid: true });
    const idle = await makeAccount(services, "idle@example.com", { credits: 250, bucket: "trial" });
    await services.ledger.spend(trial.account.id, 40, "u1");
    const usage = `INSERT INTO usage_events (account_id, operation, channel, credits, status) VALUES ($1, $2, 'mcp', $3, 'ok')`;
    await services.db.query(usage, [trial.account.id, "search_sites", 30]);
    await services.db.query(usage, [trial.account.id, "lookup_domain", 10]);
    await services.db.query(usage, [trial.account.id, "find_technologies", 0]);
    await services.db.query(usage, [paid.account.id, "search_sites", 400]);
    await services.db.query(usage, [idle.account.id, "find_technologies", 0]);
    const spenders = await topTrialSpenders(services.db);
    expect(spenders).toEqual([
      { account_id: trial.account.id, email: "trial@example.com", status: "active", calls: 3, credits: 40, balance: 210 },
    ]);
  });

  it("loads the whole dashboard, including pending requests", async () => {
    const a = await grant("withheld", "198.51.100.0/24");
    await services.db.query(`INSERT INTO free_credit_requests (account_id, message) VALUES ($1, 'hi')`, [a.id]);
    await recordSignal(services, { accountId: a.id, kind: "grant_withheld_not_work_email" });
    expect(await pendingRequestCount(services.db)).toBe(1);
    const d = await loadDashboard(services.db);
    expect(d.pendingRequests).toBe(1);
    expect(d.signals.map((s) => s.kind)).toEqual(["grant_withheld_not_work_email"]);
    expect(d.networks).toHaveLength(1);
    expect(d.conversion.rate).toBeNull();
    expect(await recentSignals(services.db, { accountId: a.id })).toHaveLength(1);
  });
});
