// Every bigint parses as a number before anything can query through this pool:
// importing pgTypes.ts registers its parsers. pg looks a type's parser up once
// per result, when its column descriptions arrive, so what matters is that the
// import has run before the first query, and nothing can reach this Pool
// without it. See pgTypes.ts, and pool.test.ts for what checks this file.
import { Pool, type PoolClient } from "pg";
import { clientReplaced, driverReplaced } from "./pgTypes.js";

type Checkout = Parameters<Pool["connect"]>[0];

// The parsers live in a registry the whole process shares, so a line anywhere
// can replace them after this module has loaded: a stray setTypeParser, or pg's
// own `pg.defaults.parseInt8 = true` (int4's parseInt, which rounds past 2^53)
// or `= false` (pg's text parser, ids as text again), the most copied line for
// getting bigints as numbers. A client also asks its own `types` first, if the
// Pool's options gave it any, and a client set to binary has every query with
// parameters answered in binary, which pg's binary int8 parser returns as text.
// Cold reviews put each of these past every test. So every checkout, which
// pool.query goes through too, checks the registry before connecting and the
// client it hands out after, and refuses with the reason; a connection that
// failed is passed on as it came. A refused client is released with the error,
// which removes it from the pool. A replacement made while a client is already
// checked out reaches that client's later queries until it is released; the
// next checkout refuses. Parsers or binary given to a single query never pass
// through here: db/pool.test.ts's scan is what refuses those.
class CheckedPool extends Pool {
  connect(): Promise<PoolClient>;
  connect(callback: Checkout): void;
  connect(callback?: Checkout): Promise<PoolClient> | void {
    const replaced = driverReplaced();
    if (replaced !== null) {
      const error = new Error(replaced);
      if (callback === undefined) return Promise.reject(error);
      process.nextTick(() => callback(error, undefined, () => undefined));
      return;
    }
    if (callback === undefined) {
      return super.connect().then((client) => {
        const wrong = clientReplaced(client);
        if (wrong === null) return client;
        const error = new Error(wrong);
        client.release(error);
        throw error;
      });
    }
    super.connect((err, client, done) => {
      if (err || client === undefined) return callback(err, client, done);
      const wrong = clientReplaced(client);
      if (wrong === null) return callback(undefined, client, done);
      const error = new Error(wrong);
      done(error);
      callback(error, undefined, () => undefined);
    });
  }
}

// pg defaults `connectionTimeoutMillis` to 0, meaning a checkout waits for a
// free connection forever, and Postgres will happily run a statement forever
// too. Both failure modes look identical from the outside: a request that
// simply never answers. The phone can only report that as a timeout, with no
// way to tell a slow network from a wedged server -- which is exactly the
// ambiguity that made "Couldn't start tracking" impossible to read. Failing
// fast turns an invisible hang into an error with a cause attached.
export const pool = new CheckedPool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  statement_timeout: 60_000,
  max: 10,
});
