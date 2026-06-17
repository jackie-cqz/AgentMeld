import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

declare global {
  var __agentConferenceDb: SqlDatabase | undefined;
}

interface SqlStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  pragma?: (source: string) => unknown;
  close?: () => void;
}

type BetterSqliteConstructor = new (filename: string) => SqlDatabase;
type NodeSqliteModule = {
  DatabaseSync: new (filename: string) => SqlDatabase;
};

const requireFromHere = createRequire(import.meta.url);

export function getDataDir() {
  const dir = process.env.AGENT_CONFERENCE_DATA_DIR
    ? path.resolve(process.env.AGENT_CONFERENCE_DATA_DIR)
    : path.join(/*turbopackIgnore: true*/ process.cwd(), ".agent-conference-data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDatabase() {
  if (!globalThis.__agentConferenceDb) {
    const dbPath = path.join(getDataDir(), "agent-conference.db");
    globalThis.__agentConferenceDb = openDatabase(dbPath);
    setPragma(globalThis.__agentConferenceDb, "journal_mode = WAL");
    setPragma(globalThis.__agentConferenceDb, "foreign_keys = ON");
  }
  return globalThis.__agentConferenceDb;
}

export function resetDatabaseForTests() {
  globalThis.__agentConferenceDb?.close?.();
  globalThis.__agentConferenceDb = undefined;
}

function openDatabase(dbPath: string): SqlDatabase {
  try {
    const Database = requireFromHere("better-sqlite3") as BetterSqliteConstructor;
    return new Database(dbPath);
  } catch (error) {
    if (!canFallbackToNodeSqlite(error)) {
      throw error;
    }
    const { DatabaseSync } = getNodeSqlite();
    return new DatabaseSync(dbPath);
  }
}

function setPragma(db: SqlDatabase, source: string) {
  if (db.pragma) {
    db.pragma(source);
    return;
  }
  db.exec(`PRAGMA ${source}`);
}

function canFallbackToNodeSqlite(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("Could not locate the bindings file") || error.message.includes("Cannot find module"))
  );
}

function getNodeSqlite() {
  const builtin = (process as unknown as {
    getBuiltinModule?: (id: string) => unknown;
  }).getBuiltinModule?.("node:sqlite") as NodeSqliteModule | undefined;

  if (!builtin) {
    throw new Error("Node sqlite fallback is unavailable in this runtime.");
  }

  return builtin;
}
