import { Pool } from "pg";

// pg defaults `connectionTimeoutMillis` to 0, meaning a checkout waits for a
// free connection forever, and Postgres will happily run a statement forever
// too. Both failure modes look identical from the outside: a request that
// simply never answers. The phone can only report that as a timeout, with no
// way to tell a slow network from a wedged server -- which is exactly the
// ambiguity that made "Couldn't start tracking" impossible to read. Failing
// fast turns an invisible hang into an error with a cause attached.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 60_000,
  max: 10,
});
