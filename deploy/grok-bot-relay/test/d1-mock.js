/**
 * Isolated Cloudflare D1 In-Memory Emulator for testing.
 * Uses Node 22 built-in node:sqlite to provide 100% faithful SQLite execution.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class D1DatabaseMock {
  constructor(initSchema = true) {
    this._db = new DatabaseSync(":memory:");
    if (initSchema) {
      // Initialize schema from schema.sql
      const schemaPath = path.resolve(__dirname, "../schema.sql");
      const schemaSql = fs.readFileSync(schemaPath, "utf-8");
      this._db.exec(schemaSql);
    }
  }

  prepare(query) {
    return new D1PreparedStatementMock(this._db, query);
  }

  async batch(statements) {
    const results = [];
    this._db.exec("BEGIN TRANSACTION");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this._db.exec("COMMIT");
      return results;
    } catch (e) {
      this._db.exec("ROLLBACK");
      throw e;
    }
  }

  async exec(sql) {
    this._db.exec(sql);
    return { count: 0, duration: 0 };
  }

  close() {
    this._db.close();
  }
}

export class D1PreparedStatementMock {
  constructor(db, query, params = []) {
    this._db = db;
    this._query = query;
    this._params = params;
  }

  bind(...params) {
    // Flatten if an array is passed, or use params as is
    return new D1PreparedStatementMock(this._db, this._query, params);
  }

  async first(col) {
    const stmt = this._db.prepare(this._query);
    const row = stmt.get(...this._params);
    if (!row) return null;
    if (col && typeof col === "string") return row[col];
    return row;
  }

  async all() {
    const stmt = this._db.prepare(this._query);
    const rows = stmt.all(...this._params);
    return {
      results: rows,
      success: true,
      meta: {}
    };
  }

  async run() {
    const stmt = this._db.prepare(this._query);
    const info = stmt.run(...this._params);
    return {
      success: true,
      meta: {
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid)
      }
    };
  }
}
