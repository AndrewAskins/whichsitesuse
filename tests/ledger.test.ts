import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InsufficientCreditsError } from "../src/billing/ledger.js";
import { createTestDb, makeAccount, TEST_DATABASE_URL, type TestDb } from "./helpers/db.js";

describe.skipIf(!TEST_DATABASE_URL)("credit ledger", () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t?.drop());

  it("spends plan credits first, then top-ups, then the free grant", async () => {
    const { account } = await makeAccount(t.services, "order@acme.com");
    const { ledger } = t.services;
    await ledger.addLot({ accountId: account.id, bucket: "trial", kind: "grant", credits: 250, ref: `grant:${account.id}` });
    await ledger.addLot({ accountId: account.id, bucket: "topup", kind: "topup", credits: 1000, expiresAt: new Date(Date.now() + 86400_000 * 365) });
    await ledger.addLot({ accountId: account.id, bucket: "plan", kind: "plan", credits: 100, expiresAt: new Date(Date.now() + 86400_000 * 30) });

    const after = await ledger.spend(account.id, 150, "usage:1");
    expect(after).toMatchObject({ plan: 0, topup: 950, trial: 250, total: 1200 });
    const spends = (await ledger.history(account.id)).filter((r) => r.kind === "spend");
    expect(spends.map((r) => r.amount).sort()).toEqual([-100, -50]);
  });

  it("refuses to overspend and changes nothing", async () => {
    const { account } = await makeAccount(t.services, "broke@acme.com", { credits: 10 });
    await expect(t.services.ledger.spend(account.id, 11, "usage:2")).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect((await t.services.ledger.balance(account.id)).total).toBe(10);
  });

  it("adds a referenced lot once, however often it's replayed", async () => {
    const { account } = await makeAccount(t.services, "replay@acme.com");
    const lot = { accountId: account.id, bucket: "topup" as const, kind: "topup" as const, credits: 1000, ref: "cs_test_1" };
    expect(await t.services.ledger.addLot(lot)).toBe(true);
    expect(await t.services.ledger.addLot(lot)).toBe(false);
    expect((await t.services.ledger.balance(account.id)).total).toBe(1000);
  });

  it("ignores expired lots and sweeps them into the ledger", async () => {
    const { account } = await makeAccount(t.services, "old@acme.com");
    await t.services.ledger.addLot({ accountId: account.id, bucket: "plan", kind: "plan", credits: 500, expiresAt: new Date(Date.now() - 1000) });
    expect((await t.services.ledger.balance(account.id)).total).toBe(0);
    expect(await t.services.ledger.sweepExpired()).toBeGreaterThanOrEqual(1);
    expect((await t.services.ledger.history(account.id))[0]).toMatchObject({ kind: "expire", amount: -500 });
  });

  it("revokes a bucket's unspent credits", async () => {
    const { account } = await makeAccount(t.services, "farm@acme.com", { credits: 250, bucket: "trial" });
    expect(await t.services.ledger.clearBucket(account.id, "revoke", { bucket: "trial", createdBy: "admin@x.com" })).toBe(250);
    expect((await t.services.ledger.balance(account.id)).total).toBe(0);
  });
});
