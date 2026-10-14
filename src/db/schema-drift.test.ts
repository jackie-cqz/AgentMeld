import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import { getDatabase } from "@/db/client";
import * as schema from "@/db/schema";
import { setupTestDatabase } from "@/test/test-database";

/**
 * Full-text search is an implementation detail of the search index, not part of
 * the application data model. `bootstrap.ts` creates these FTS5 virtual tables
 * plus their internal shadow tables, which SQLite names `<root>_data`,
 * `<root>_idx`, `<root>_content`, `<root>_docsize` and `<root>_config`.
 *
 * They are excluded deliberately, by root name only, and the roots themselves
 * are asserted below so a newly added search table cannot slip through
 * unnoticed. Everything else created by `bootstrap.ts` MUST be mirrored in
 * `schema.ts`.
 */
const FTS_VIRTUAL_TABLES = ["context_fts_messages", "context_fts_tasks", "messages_fts"] as const;

type SqliteMasterRow = { name: string; sql: string | null };

function readSqliteMasterTables(): SqliteMasterRow[] {
  return getDatabase()
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as SqliteMasterRow[];
}

function isFtsImplementationTable(tableName: string, ftsRoots: string[]) {
  return ftsRoots.some((root) => tableName === root || tableName.startsWith(`${root}_`));
}

function readRuntimeColumnNames(tableName: string): string[] {
  const rows = getDatabase()
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function readDrizzleSchemaTables(): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const config = getTableConfig(value);
    tables.set(
      config.name,
      config.columns.map((column) => column.name)
    );
  }
  return tables;
}

/** Names present in `actual` but absent from `expected`, sorted for stable diffs. */
function difference(actual: Iterable<string>, expected: Iterable<string>): string[] {
  const expectedSet = new Set(expected);
  return [...actual].filter((name) => !expectedSet.has(name)).sort();
}

describe("schema drift guard: src/db/schema.ts mirrors src/db/bootstrap.ts", () => {
  let teardown: (() => void) | undefined;

  afterEach(() => {
    teardown?.();
    teardown = undefined;
  });

  it("declares exactly the tables and columns that bootstrap creates", () => {
    teardown = setupTestDatabase("agentmeld-schema-drift-");

    const sqliteMasterRows = readSqliteMasterTables();
    const ftsRoots = sqliteMasterRows
      .filter((row) => /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(row.sql ?? ""))
      .map((row) => row.name)
      .sort();

    // Guard the exclusion list itself: only the known search tables are excused.
    expect(
      ftsRoots,
      `Unexpected FTS virtual table(s) created by bootstrap.ts.\n` +
        `  found: ${ftsRoots.join(", ") || "(none)"}\n` +
        `  expected: ${[...FTS_VIRTUAL_TABLES].sort().join(", ")}\n` +
        `If a search table was added or removed, update FTS_VIRTUAL_TABLES and this test deliberately.`
    ).toEqual([...FTS_VIRTUAL_TABLES].sort());

    const runtimeTables = new Set(
      sqliteMasterRows
        .map((row) => row.name)
        .filter((name) => !isFtsImplementationTable(name, ftsRoots))
    );
    const drizzleTables = readDrizzleSchemaTables();

    const missingInDrizzle = difference(runtimeTables, drizzleTables.keys());
    const extraInDrizzle = difference(drizzleTables.keys(), runtimeTables);
    expect(
      { missingInDrizzle, extraInDrizzle },
      `Table drift between bootstrap.ts (runtime authority) and schema.ts (typed mirror).\n` +
        `  missing from schema.ts (add these tables): ${missingInDrizzle.join(", ") || "(none)"}\n` +
        `  declared in schema.ts but never created by bootstrap.ts: ${extraInDrizzle.join(", ") || "(none)"}`
    ).toEqual({ missingInDrizzle: [], extraInDrizzle: [] });

    const columnProblems: string[] = [];
    for (const [tableName, drizzleColumns] of drizzleTables) {
      if (!runtimeTables.has(tableName)) continue;
      const runtimeColumns = readRuntimeColumnNames(tableName);
      const missingColumns = difference(runtimeColumns, drizzleColumns);
      const extraColumns = difference(drizzleColumns, runtimeColumns);
      if (missingColumns.length > 0 || extraColumns.length > 0) {
        columnProblems.push(
          `  ${tableName}: missing from schema.ts [${missingColumns.join(", ") || "-"}] ` +
            `| declared but not created [${extraColumns.join(", ") || "-"}]`
        );
      }
    }
    expect(
      columnProblems,
      `Column drift between bootstrap.ts (runtime authority) and schema.ts (typed mirror).\n` +
        `Each line lists columns to add to / remove from schema.ts:\n${columnProblems.join("\n")}`
    ).toEqual([]);
  });
});
