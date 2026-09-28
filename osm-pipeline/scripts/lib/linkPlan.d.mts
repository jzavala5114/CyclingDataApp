// The contract the backend's eval reads this module through.
//
// osm-pipeline is plain JS on purpose -- it is a handful of scripts run by hand
// against a database, and it carries no TypeScript toolchain. But
// backend/src/scripts/evalLinkerFold.ts has to score the linker's decisions
// against the matcher's behaviour, so it needs both halves, and an untyped
// import there would be an `any` hole in a typechecked service. Declaring the
// shape here keeps the pipeline dependency-free and the backend honest.
//
// Keep this in step with linkPlan.mjs by hand. A build step to generate it
// would cost more than it saves, but hand-maintained means it drifts: this file
// declared an `onProgress(scanned, at, hi)` whose `hi` came from the id-range
// pagination that the same change replaced, and omitted five exports. Only the
// names the backend imports have to be right for the typecheck to pass, so the
// rest drifts silently. Declare everything, and check it when you touch it.

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

/** A row the run would write: the decision plus the parent it will store. */
export interface Write extends Decision {
  writeParent: number | null;
  action: "fold" | "release" | "reparent";
}

export interface Flags {
  apply: boolean;
  unfold: boolean;
  reparent: boolean;
}

export interface RunPlan {
  decided: Decision[];
  counts: Tally;
  writes: Write[];
  folds: Write[];
  releases: Write[];
  reparents: Write[];
  namedFolds: Write[];
  /** Named folds whose name is not itself a sidewalk. The caller throws. */
  unintended: Write[];
  /** Folds where no single road holds a third of the path. */
  thin: Write[];
}

export declare const MIN_FRONTAGE: number;
export declare const PREFILTER_DEG: number;
export declare const CANDIDATE_SQL: string;

export declare function prefilterReachM(lat?: number): number;
export declare function eligibleSql(alias: string): string;
export declare function candidateQuery(
  after: number,
  batch?: number,
): { text: string; values: (number | null)[] };

export declare function buildLinkPlan(
  client: Pool | PoolClient,
  opts?: { onProgress?: (measured: number, after: number) => void; batchSize?: number },
): Promise<PlanRecord[]>;

export declare function decide(plan: PlanRecord[], minFrontage: number): Decision[];
export declare function tally(decided: Decision[]): Tally;
export declare function parseFlags(argv?: string[]): Flags;
export declare function plannedParent(
  d: Pick<Decision, "id" | "currentParent" | "newParent">,
  opts?: { unfold?: boolean; reparent?: boolean },
): number | null;
export declare function writesFor(
  decided: Decision[],
  opts?: { unfold?: boolean; reparent?: boolean },
): Write[];
export declare function planRun(
  plan: PlanRecord[],
  opts?: { unfold?: boolean; reparent?: boolean },
): RunPlan;
export declare function updateBatch(batch: Pick<Write, "id" | "writeParent">[]): {
  sql: string;
  values: (number | null)[];
};
export declare function applyWrites(
  client: Pool | PoolClient,
  writes: Pick<Write, "id" | "writeParent">[],
  opts?: { batchSize?: number; onProgress?: (written: number, total: number) => void },
): Promise<number>;
