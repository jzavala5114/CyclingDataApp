Three of Supabase's own database advisor rules, copied verbatim from
github.com/supabase/splinter (`lints/`, commit `cc529aa`, 2026-11-17) under its
PostgreSQL License (`LICENSE`, beside them). They are the rules the dashboard's
Security Advisor runs, so `npm run eval:security` predicts what it will say:

- `0013_rls_disabled_in_public.sql` (ERROR): a table the API's roles may select
  from, with row level security off.
- `0023_sensitive_columns_exposed.sql` (ERROR): the same, on a table with a
  column named like a secret (`session_id` matches, though ours is a ride).
- `0008_rls_enabled_no_policy.sql` (INFO): row level security on and no
  policy. For our tables that is the intended state: no row reaches the API.

`securityChecks.ts` sends each one's SELECT, its `create view` line removed,
from `rules.ts`: constants, so `npm run eval:query-types` can read and describe
them like every other statement. `buildRules.ts` writes `rules.ts` from these
files, and `securityChecks.test.ts` fails if the two differ. To update: fetch
the same files from splinter's `lints/` again, run
`npx tsx src/scripts/splinter/buildRules.ts`, and say so in this file.
