// What buildRules.ts and securityChecks.test.ts share: which rules are copied,
// and how a rule's file becomes the statement sent.

export const RULE_FILES = [
  { file: "0008_rls_enabled_no_policy.sql", constant: "RULE_0008" },
  { file: "0013_rls_disabled_in_public.sql", constant: "RULE_0013" },
  { file: "0023_sensitive_columns_exposed.sql", constant: "RULE_0023" },
] as const;

/**
 * A splinter rule's SELECT: its file less the `create view ... as` line it is
 * shipped with, and any closing semicolon, with LF line ends. Git on Windows
 * checks the files out with CRLF, while a template literal in rules.ts reads
 * back LF whatever its file holds, so both sides compare in LF.
 */
export function ruleStatement(file: string, sql: string): string {
  const text = sql.replace(/\r\n/g, "\n");
  const header = /^\s*create view [^\n]* as\s*\n/i;
  if (!header.test(text)) throw new Error(`${file}: not a splinter rule (no "create view ... as" line)`);
  return text.replace(header, "").trim().replace(/;\s*$/, "");
}
