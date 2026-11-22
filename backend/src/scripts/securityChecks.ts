import type { PoolClient } from "pg";
import { expectedTables } from "./backupFormat.js";
import { RULE_0008, RULE_0013, RULE_0023 } from "./splinter/rules.js";

// Whether Supabase's public API roles can reach anything of ours, read from
// the database's own catalog: row level security on every table of ours in
// public, no privilege at all for `anon` or `authenticated` on any table,
// view or sequence of ours, nothing for them in the default privileges of the
// role that owns our tables, and Supabase's own advisor rules (splinter/)
// finding nothing of ours. migrations/004_row_level_security.sql says why each
// part matters.
//
// "Ours" is everything in public that no extension owns. PostGIS owns
// spatial_ref_sys, two views and its functions; supabase_admin installed it and
// made their grants, so nothing we run can change them, and they are reported
// apart, as not ours, rather than failed.
//
// Written apart from the migration's own closing check (a DO block in plain
// SQL), so each judges the other: a mistake in one is unlikely to be the same
// mistake in both. Every statement only reads.

/** The roles Supabase's Data API acts as for a request: with the public anon key, or a signed-in user's token. */
export const API_ROLES = ["anon", "authenticated"] as const;

const ROLE_LIST = API_ROLES as readonly string[];

// pg_depend's 'e': a member of an extension.
const NOT_AN_EXTENSION_MEMBER = `not exists (select 1 from pg_catalog.pg_depend d
   where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')`;

export interface Exposure {
  name: string;
  kind: string;
  role: string;
  privilege: string;
}

export interface DefaultGrant {
  creator: string;
  schema: string;
  objects: string;
  grantee: string;
  privilege: string;
}

export interface AdvisorFinding {
  lint: string;
  level: string;
  detail: string;
  /** The table it names, when it names one. */
  table: string | null;
  /** Whether the table is ours, not an extension's. */
  ours: boolean;
}

export interface SecurityReport {
  server: string;
  /** The tables schema.sql creates that public lacks: a check over a database without them proves nothing. */
  missingTables: string[];
  /** How many of ours were checked. */
  tables: number;
  sequences: number;
  /** The roles owning our tables, whose default privileges are checked. */
  owners: string[];
  rowSecurityOff: string[];
  exposures: Exposure[];
  defaults: DefaultGrant[];
  advisor: AdvisorFinding[];
  /** What extensions own in public: not ours to change. */
  extensionRelations: string[];
}

/** The table privileges a role can hold: MAINTAIN from PostgreSQL 17. */
export function tablePrivileges(serverVersionNum: number): string[] {
  const all = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
  return serverVersionNum >= 170000 ? [...all, "MAINTAIN"] : all;
}

export const SUBJECTS_SQL = `
select c.relname as name, c.relkind as kind, c.relrowsecurity as "rowSecurity", pg_catalog.pg_get_userbyid(c.relowner) as owner
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and ${NOT_AN_EXTENSION_MEMBER}
 order by c.relname`;

export const EXTENSION_RELATIONS_SQL = `
select c.relname as name
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and not ${NOT_AN_EXTENSION_MEMBER}
 order by c.relname`;

// $1 the API's roles, $2 the table privileges. A column privilege is reported
// only where the role lacks the same privilege on the whole table, which
// has_any_column_privilege also counts.
// Functions too: every new function is executable by PUBLIC, by a default of
// PostgreSQL's own that no per-schema change removes (004 says why it is left),
// so a function of ours is open unless it revoked that itself, and is caught
// here by name.
export const EXPOSURES_SQL = `
select * from (
  select c.relname as name,
         case c.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'materialized view'
                        when 'f' then 'foreign table' else 'table' end as kind,
         r.role, p.privilege
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    cross join unnest($1::text[]) as r(role)
    cross join lateral (
      select t.p as privilege from unnest($2::text[]) as t(p)
       where c.relkind <> 'S' and pg_catalog.has_table_privilege(r.role, c.oid, t.p)
      union all
      select t.p || ' on a column' from unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as t(p)
       where c.relkind <> 'S' and pg_catalog.has_any_column_privilege(r.role, c.oid, t.p)
         and not pg_catalog.has_table_privilege(r.role, c.oid, t.p)
      union all
      select s.p from unnest(array['USAGE', 'SELECT', 'UPDATE']) as s(p)
       where c.relkind = 'S' and pg_catalog.has_sequence_privilege(r.role, c.oid, s.p)
    ) as p
   where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and ${NOT_AN_EXTENSION_MEMBER}
  union all
  select f.proname || '(' || pg_catalog.pg_get_function_identity_arguments(f.oid) || ')',
         case f.prokind when 'p' then 'procedure' when 'a' then 'aggregate' when 'w' then 'window function' else 'function' end,
         r.role, 'EXECUTE'
    from pg_catalog.pg_proc f
    join pg_catalog.pg_namespace n on n.oid = f.pronamespace
    cross join unnest($1::text[]) as r(role)
   where n.nspname = 'public' and pg_catalog.has_function_privilege(r.role, f.oid, 'EXECUTE')
     and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e')
) as exposed
order by 1, 3, 4`;

// $1 the owners of our tables, $2 the API's roles. A grant to PUBLIC reaches
// the API's roles too; for functions PostgreSQL gives PUBLIC EXECUTE by its
// own built-in default, which is no entry here (EXPOSURES_SQL catches each
// function it opens), so only an explicit one counts.
export const DEFAULTS_SQL = `
select d.defaclrole::regrole::text as creator,
       case when d.defaclnamespace = 0 then '(every schema)' else d.defaclnamespace::regnamespace::text end as schema,
       case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' end as objects,
       case when g.grantee = 0 then 'PUBLIC' else g.grantee::regrole::text end as grantee,
       g.privilege_type as privilege
  from pg_catalog.pg_default_acl d, pg_catalog.aclexplode(d.defaclacl) g
 where d.defaclrole::regrole::text = any($1::text[])
   and (d.defaclnamespace = 0 or d.defaclnamespace::regnamespace::text = 'public')
   and d.defaclobjtype in ('r', 'S', 'f')
   and (g.grantee <> 0 and g.grantee::regrole::text = any($2::text[]) or g.grantee = 0 and d.defaclobjtype in ('r', 'S'))
 order by 1, 2, 3, 4, 5`;

/**
 * Supabase's advisor rules, run as sent (splinter/rules.ts, generated from the
 * copied .sql files): the two that fail a check, and the one only reported.
 * Constants, so evalQueryTypes' census reads and describes them as it does
 * every other statement.
 */
export const ADVISOR = [
  { lint: "0013_rls_disabled_in_public", sql: RULE_0013, gate: true },
  { lint: "0023_sensitive_columns_exposed", sql: RULE_0023, gate: true },
  { lint: "0008_rls_enabled_no_policy", sql: RULE_0008, gate: false },
] as const;
export const ADVISOR_GATES: readonly string[] = ADVISOR.filter((r) => r.gate).map((r) => r.lint);
export const ADVISOR_INFO: readonly string[] = ADVISOR.filter((r) => !r.gate).map((r) => r.lint);

/**
 * Reads everything the checks judge. The caller holds `db` in a read-only
 * transaction; `schemaSql` is schema.sql, which names the tables that must be
 * there for the checks to mean anything.
 */
export async function securityReport(db: Pick<PoolClient, "query">, schemaSql: string): Promise<SecurityReport> {
  const { rows: version } = await db.query<{ server: string; num: number }>(
    "select current_setting('server_version') as server, current_setting('server_version_num')::int as num",
  );
  const { rows: subjects } = await db.query<{ name: string; kind: string; rowSecurity: boolean; owner: string }>(SUBJECTS_SQL);
  const tables = subjects.filter((s) => s.kind === "r" || s.kind === "p");
  const present = new Set(tables.map((t) => t.name));
  const expected = expectedTables(schemaSql);
  const owners = [...new Set(tables.filter((t) => expected.includes(t.name)).map((t) => t.owner))].sort();

  const { rows: exposures } = await db.query<Exposure>(EXPOSURES_SQL, [ROLE_LIST, tablePrivileges(version[0]!.num)]);
  const { rows: defaults } = await db.query<DefaultGrant>(DEFAULTS_SQL, [owners, ROLE_LIST]);
  const { rows: extension } = await db.query<{ name: string }>(EXTENSION_RELATIONS_SQL);
  const extensionRelations = extension.map((r) => r.name);

  const advisor: AdvisorFinding[] = [];
  for (const rule of ADVISOR) {
    // Every column a splinter rule returns, so the census reads none as undeclared.
    const { rows } = await db.query<{
      name: string;
      title: string;
      level: string;
      facing: string;
      categories: string[];
      description: string;
      detail: string;
      remediation: string;
      metadata: { schema?: string; name?: string } | null;
      cache_key: string;
    }>(rule.sql);
    for (const row of rows) {
      const table = row.metadata?.schema === "public" && row.metadata.name ? row.metadata.name : null;
      advisor.push({
        lint: rule.lint,
        level: row.level,
        detail: row.detail,
        table,
        ours: table === null || !extensionRelations.includes(table),
      });
    }
  }

  return {
    server: version[0]!.server,
    missingTables: expected.filter((t) => !present.has(t)),
    tables: tables.length,
    sequences: subjects.filter((s) => s.kind === "S").length,
    owners,
    rowSecurityOff: tables.filter((t) => !t.rowSecurity).map((t) => t.name),
    exposures,
    defaults,
    advisor,
    extensionRelations,
  };
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** One object's exposures on a line: "sessions (table): anon SELECT INSERT; authenticated SELECT". */
export function describeExposures(exposures: readonly Exposure[]): string[] {
  const byObject = new Map<string, Map<string, string[]>>();
  for (const e of exposures) {
    const key = `${e.name} (${e.kind})`;
    const roles = byObject.get(key) ?? new Map<string, string[]>();
    roles.set(e.role, [...(roles.get(e.role) ?? []), e.privilege]);
    byObject.set(key, roles);
  }
  return [...byObject].map(([object, roles]) => `${object}: ${[...roles].map(([role, privileges]) => `${role} ${privileges.join(" ")}`).join("; ")}`);
}

/** One line per kind of object and role: "postgres, in public, new tables: anon DELETE INSERT ...". */
export function describeDefaults(defaults: readonly DefaultGrant[]): string[] {
  const lines = new Map<string, string[]>();
  for (const d of defaults) {
    const key = `${d.creator}, in ${d.schema}, new ${d.objects}: ${d.grantee}`;
    lines.set(key, [...(lines.get(key) ?? []), d.privilege]);
  }
  return [...lines].map(([key, privileges]) => `${key} ${privileges.join(" ")}`);
}

/** Supabase's rules write some backticks escaped (`\``), which reads as noise. */
const plain = (detail: string) => detail.replace(/\\`/g, "`");

/** The checks, from a report. A check with nothing to judge fails rather than passing empty. */
export function securityChecks(report: SecurityReport): Check[] {
  const gates = report.advisor.filter((f) => ADVISOR_GATES.includes(f.lint));
  const oursFlagged = gates.filter((f) => f.ours);
  return [
    {
      name: `the tables schema.sql creates are all here, so the checks below judge something (${report.tables} tables, ${report.sequences} sequences of ours)`,
      ok: report.missingTables.length === 0 && report.tables > 0 && report.owners.length > 0,
      detail: report.missingTables.length > 0 ? `missing: ${report.missingTables.join(", ")}` : "no table of ours in public",
    },
    {
      name: "row level security is on for every table of ours",
      ok: report.rowSecurityOff.length === 0,
      detail: `off: ${report.rowSecurityOff.join(", ")}`,
    },
    {
      name: `${API_ROLES.join(" and ")} may do nothing to any table, view, sequence or function of ours`,
      ok: report.exposures.length === 0,
      detail: describeExposures(report.exposures).join("\n"),
    },
    {
      name: `the default privileges of ${report.owners.join(", ") || "our tables' owner"} give ${API_ROLES.join(" and ")} no grant on later tables, sequences or functions (PostgreSQL's own PUBLIC EXECUTE on a new function is caught per function, above)`,
      ok: report.defaults.length === 0 && report.owners.length > 0,
      detail: describeDefaults(report.defaults).join("\n"),
    },
    {
      name: "Supabase's advisor (0013, 0023) flags nothing of ours",
      ok: oursFlagged.length === 0,
      detail: oursFlagged.map((f) => `${f.lint}: ${plain(f.detail)}`).join("\n"),
    },
  ];
}

/** What the report says beyond pass and fail: the advisor's INFO lines, and what is not ours to change. */
export function securityNotes(report: SecurityReport): string[] {
  const notes: string[] = [];
  const noPolicy = report.advisor.filter((f) => ADVISOR_INFO.includes(f.lint));
  if (noPolicy.length > 0) {
    notes.push(
      `advisor 0008 (INFO), row level security on with no policy: ${noPolicy.length} (${noPolicy.map((f) => f.table).join(", ")}). Intended: no row reaches the API.`,
    );
  }
  const theirs = report.advisor.filter((f) => !f.ours);
  if (report.extensionRelations.length > 0) {
    notes.push(
      `not ours: an extension owns ${report.extensionRelations.join(", ")} in public` +
        (theirs.length > 0 ? `; the advisor flags ${[...new Set(theirs.map((f) => f.table))].join(", ")}` : "") +
        ". Only the Data API being off keeps them from the outside.",
    );
  }
  return notes;
}
