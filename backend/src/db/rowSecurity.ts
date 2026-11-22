// Every table this app creates has row level security on, in a new database
// (schema.sql) and in the live one (the migrations, in order), so Supabase's
// public API roles never reach a row of it; nothing grants those roles
// anything; and every function this app creates is closed to PUBLIC, which
// every role holds. migrations/004_row_level_security.sql says why;
// rowSecurity.test.ts holds the real files to this.
//
// Read from the text, statement by statement in order. A statement must start
// its line, so a `--` comment mentioning one is not one, and block comments
// are removed first. A statement built at run time (EXECUTE format(...) in a
// DO block) is not read: say so beside any such statement.

export interface SqlFile {
  name: string;
  sql: string;
}

/** The API's roles, and PUBLIC, which every role is a member of. */
const OPENERS = new Set(["anon", "authenticated", "public"]);

/** `sql` with its block comments blanked, line breaks kept, so positions and line starts stay where they were. */
export function withoutBlockComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, " "));
}

type TableEvent = { at: number; table: string; kind: "create" | "enable" | "disable" };

const NAME = String.raw`(?:public\.)?"?(\w+)"?`;
const CREATE_TABLE = new RegExp(String.raw`^\s*create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}`, "gim");
const SWITCH_TABLE = new RegExp(String.raw`^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+(enable|disable)\s+row\s+level\s+security\s*;`, "gim");

/** What a script does to tables' row level security, in the order it does it. */
export function tableEvents(sql: string): TableEvent[] {
  const text = withoutBlockComments(sql);
  const events: TableEvent[] = [];
  for (const m of text.matchAll(CREATE_TABLE)) events.push({ at: m.index!, table: m[1]!, kind: "create" });
  for (const m of text.matchAll(SWITCH_TABLE)) events.push({ at: m.index!, table: m[1]!, kind: m[2]!.toLowerCase() as "enable" | "disable" });
  return events.sort((a, b) => a.at - b.at);
}

/** The tables a script switches row level security on for. */
export function rowSecurityTables(sql: string): string[] {
  return [...new Set(tableEvents(sql).filter((e) => e.kind === "enable").map((e) => e.table))].sort();
}

/** The tables a script creates. */
export function createdTables(sql: string): string[] {
  return [...new Set(tableEvents(sql).filter((e) => e.kind === "create").map((e) => e.table))].sort();
}

/**
 * Every GRANT (and every ALTER DEFAULT PRIVILEGES ... GRANT) in a script that
 * gives something to `anon`, `authenticated` or PUBLIC: the statement, cut short.
 */
export function grantsToOpeners(sql: string): string[] {
  const found: string[] = [];
  const grant = /^\s*(?:alter\s+default\s+privileges\b[^;]*?)?\bgrant\b[^;]*?\bto\s+([^;]+?)\s*;/gim;
  for (const m of withoutBlockComments(sql).matchAll(grant)) {
    const roles = m[1]!
      .replace(/\bwith\s+(?:grant|admin|inherit|set)\s+option\b.*/is, "")
      .replace(/\bgranted\s+by\b.*/is, "")
      .split(",")
      .map((r) => r.trim().replace(/^"|"$/g, "").toLowerCase());
    if (roles.some((r) => OPENERS.has(r))) found.push(m[0].trim().replace(/\s+/g, " ").slice(0, 120));
  }
  return found;
}

type FunctionEvent = { at: number; name: string | null; kind: "create" | "close" };

// By name, not signature: of two overloads of one name, closing one passes for
// both here (a stated limit; the app has no function yet). eval:security
// checks each overload on the live database by its arguments.
const CREATE_FUNCTION = new RegExp(String.raw`^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+${NAME}\s*\(`, "gim");
// EXECUTE (or everything) on one routine, or on every one in public, taken from PUBLIC.
const CLOSE_FUNCTION = new RegExp(
  String.raw`^\s*revoke\s+(?:all(?:\s+privileges)?|execute)\s+on\s+(?:(?:function|procedure|routine)\s+${NAME}\s*\([^;]*?\)|all\s+(?:functions|procedures|routines)\s+in\s+schema\s+public)\s+from\s+([^;]+?)\s*(?:cascade|restrict)?\s*;`,
  "gim",
);

/** What a script does to functions' EXECUTE for PUBLIC, in order; a close with no name closes every function made before it. */
export function functionEvents(sql: string): FunctionEvent[] {
  const text = withoutBlockComments(sql);
  const events: FunctionEvent[] = [];
  for (const m of text.matchAll(CREATE_FUNCTION)) events.push({ at: m.index!, name: m[1]!, kind: "create" });
  for (const m of text.matchAll(CLOSE_FUNCTION)) {
    const roles = m[2]!.split(",").map((r) => r.trim().toLowerCase());
    if (roles.includes("public")) events.push({ at: m.index!, name: m[1] ?? null, kind: "close" });
  }
  return events.sort((a, b) => a.at - b.at);
}

/** A migration's place in the order: the number its name starts with; null for one with none. */
export function migrationNumber(name: string): number | null {
  const match = /^(\d+)_/.exec(name);
  return match ? Number(match[1]) : null;
}

/** The undo of a migration is applied only by hand, to reverse it: never part of the sequence. */
export const isUndo = (name: string) => /_undo\.sql$/i.test(name);

/**
 * Why the scripts could leave something open to Supabase's API roles; empty
 * when they cannot.
 *
 * Tables: in schema.sql, and across the migrations taken in order, the last
 * thing done to each table's row level security must be to enable it. So a
 * table re-created, or switched off, by a later migration needs enabling again
 * after. A table schema.sql creates and no migration does predates the
 * migrations; a migration must still enable it on the live database. Every
 * table a migration creates must also be in schema.sql, or a new database
 * would lack it. And schema.sql takes the API roles' default privileges away
 * before its first `create table`.
 *
 * Grants: nothing in schema.sql or a migration grants anything to anon,
 * authenticated or PUBLIC.
 *
 * Functions: each one created must have EXECUTE revoked from PUBLIC after it
 * (in the same script, or for a migration, the same or a later one).
 */
export function rowSecurityGaps(schema: string, migrations: readonly SqlFile[]): string[] {
  const gaps: string[] = [];

  const schemaEvents = tableEvents(schema);
  const created = createdTables(schema);
  for (const table of created) {
    const last = schemaEvents.filter((e) => e.table === table).pop()!;
    if (last.kind === "create") gaps.push(`schema.sql creates ${table} without enabling its row level security`);
    if (last.kind === "disable") gaps.push(`schema.sql disables ${table}'s row level security`);
  }
  const text = withoutBlockComments(schema);
  const firstCreate = text.search(/^\s*create\s+(?:unlogged\s+)?table\b/im);
  const defaultsTaken = text.search(/alter default privileges in schema public revoke all on tables from/i);
  if (firstCreate >= 0 && (defaultsTaken < 0 || defaultsTaken > firstCreate)) {
    gaps.push("schema.sql creates a table before it takes the API roles' default privileges away");
  }

  const ordered: Array<SqlFile & { number: number }> = [];
  for (const m of migrations) {
    if (isUndo(m.name)) continue;
    const number = migrationNumber(m.name);
    if (number === null) gaps.push(`${m.name}: a migration's name starts with its number`);
    else ordered.push({ ...m, number });
  }
  ordered.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));

  const last = new Map<string, { kind: TableEvent["kind"]; file: string }>();
  const firstCreatedBy = new Map<string, string>();
  for (const m of ordered) {
    for (const e of tableEvents(m.sql)) {
      last.set(e.table, { kind: e.kind, file: m.name });
      if (e.kind === "create" && !firstCreatedBy.has(e.table)) firstCreatedBy.set(e.table, m.name);
    }
  }
  for (const [table, file] of firstCreatedBy) {
    if (!created.includes(table)) gaps.push(`${file} creates ${table}, which schema.sql does not`);
  }
  for (const table of [...new Set([...created, ...firstCreatedBy.keys()])].sort()) {
    const l = last.get(table);
    if (!l) continue; // no migration touches it: the loop below says so
    if (l.kind === "create") gaps.push(`${table}: created by ${l.file}, and neither it nor a later migration enables its row level security`);
    if (l.kind === "disable") gaps.push(`${table}: ${l.file} disables its row level security, and no later migration enables it again`);
  }
  for (const table of created) {
    if (!last.has(table)) gaps.push(`${table}: no migration enables its row level security on the live database`);
  }

  for (const file of [{ name: "schema.sql", sql: schema }, ...ordered]) {
    for (const statement of grantsToOpeners(file.sql)) gaps.push(`${file.name} grants to the API's roles or PUBLIC: ${statement}`);
  }

  const openFunctions = (events: FunctionEvent[], open: Map<string, string>, file: string) => {
    for (const e of events) {
      if (e.kind === "create") open.set(e.name!, file);
      else if (e.name === null) open.clear();
      else open.delete(e.name);
    }
  };
  const schemaOpen = new Map<string, string>();
  openFunctions(functionEvents(schema), schemaOpen, "schema.sql");
  const migrationOpen = new Map<string, string>();
  for (const m of ordered) openFunctions(functionEvents(m.sql), migrationOpen, m.name);
  for (const [name, file] of [...schemaOpen, ...migrationOpen]) {
    gaps.push(`${name}: created by ${file}, and EXECUTE is not revoked from PUBLIC after it`);
  }
  return gaps;
}
