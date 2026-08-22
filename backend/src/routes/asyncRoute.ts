import type { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 only understands synchronous throws. An async handler that rejects
// produces an unhandled rejection, which Node exits on -- so a single failing
// query took the entire backend down rather than returning a 500. Wrapping
// forwards the rejection to the error middleware in index.ts instead.
//
// Express 5 does this natively; this can go when we upgrade.
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
