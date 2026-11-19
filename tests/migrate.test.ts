import pg from "pg";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";

// Runs against a throwaway Postgres when TEST_DATABASE_URL is set (CI provides one).
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("migrations", () => {
  it("apply cleanly and are idempotent", async () => {
    await migrate(url!);
    const again = await migrate(url!);
    expect(again).toEqual([]);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const { rows } = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    await client.end();
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([
        "accounts", "api_keys", "credit_lots", "credit_ledger", "usage_events", "free_grants",
        "abuse_signals", "blocked_email_domains", "allowed_email_domains", "free_credit_requests",
        "technology_overrides", "login_tokens",
      ]),
    );
  });
});
