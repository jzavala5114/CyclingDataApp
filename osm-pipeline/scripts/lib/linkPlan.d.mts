// The contract the backend's eval reads this module through.
//
// osm-pipeline is plain JS on purpose -- it is a handful of scripts run by hand
// against a database, and it carries no TypeScript toolchain. But
// backend/src/scripts/evalLinkerFold.ts has to score the linker's decisions
// against the matcher's behaviour, so it needs both halves, and an untyped
// import there would be an `any` hole in a typechecked service. Declaring the
// shape here keeps the pipeline dependency-free and the backend honest.
//
// Keep this in step with linkPlan.mjs by hand. It is 40 lines describing four
// exports; a build step to generate it would cost more than it saves.

import type { Pool, PoolClient } from "pg";

/** One path, measured. No threshold has been applied yet. */
export interface PlanRecord {
  id: number;
  kind: "footway" | "cycleway";
  isSidewalk: boolean;
  streetName: string | null;
  lengthM: number;
  /** The road it is folded into today, or null if it is still canonical. */
  currentParent: number | null;
  /** Fraction of the path running alongside ANY nearby road, 0..1. */
  frontage: number;
  /** The road holding the largest share of that frontage, or null. */
  parentId: number | null;
  /** That road's own share, 0..1. Never more than `frontage`. */
  parentFrontage: number;
  roadsNearby: number;
}

export type Change = "fold" | "unfold" | "reparent" | "unchanged";

export interface Decision extends PlanRecord {
  /** The parent the threshold implies. null means "stays canonical". */
  newParent: number | null;
  change: Change;
}

export interface Tally {
  total: number;
  fold: number;
  unfold: number;
  reparent: number;
  unchanged: number;
}

export declare const PREFILTER_DEG: number;
export declare function eligibleSql(alias: string): string;

export declare function buildLinkPlan(
  client: Pool | PoolClient,
  opts?: { onProgress?: (scanned: number, at: number, hi: number) => void },
): Promise<PlanRecord[]>;

export declare function decide(plan: PlanRecord[], minFrontage: number): Decision[];
export declare function tally(decided: Decision[]): Tally;
