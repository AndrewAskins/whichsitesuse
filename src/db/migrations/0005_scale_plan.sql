-- The Scale plan (Nov 19, 2026 pricing).
ALTER TABLE accounts DROP CONSTRAINT accounts_plan_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_plan_check CHECK (plan IN ('none', 'starter', 'growth', 'pro', 'scale'));
