import { Pool, type PoolClient } from "pg";
import format from "pg-format";
import { ConcurrencyError } from "../errors";
import type {
  StorageAdapter,
  StorageHistoryOptions,
  StorageHistoryResult,
  StorageRecord,
  StorageSetOptions,
} from "../storage/types";
import type { HistoryEntry, Provenance } from "../types";

export interface PostgresAdapterOptions {
  connectionString?: string;
  pool?: Pool;
  tableName?: string;
  historyTableName?: string;
}

/**
 * Validates table names to ensure they only contain safe characters.
 * Note: This is a first line of defense; pg-format's %I provides additional
 * escaping as defense-in-depth against SQL injection.
 */
const assertSafeName = (name: string) => {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error("Table names must be alphanumeric/underscore");
  }
};

export class PostgresAdapter implements StorageAdapter {
  private readonly pool: Pool;
  private readonly table: string;
  private readonly historyTable: string;

  constructor(options: PostgresAdapterOptions) {
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString });
    this.table = options.tableName ?? "factsheet_profiles";
    this.historyTable = options.historyTableName ?? "factsheet_history";
    assertSafeName(this.table);
    assertSafeName(this.historyTable);
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      // Use pg-format's %I for safe identifier escaping
      await client.query(format(`
        CREATE TABLE IF NOT EXISTS %I (
          user_id TEXT PRIMARY KEY,
          profile JSONB NOT NULL,
          provenance JSONB NOT NULL,
          version INT NOT NULL DEFAULT 1,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS %I (
          id BIGSERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          field TEXT NOT NULL,
          entry JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS %I
          ON %I (user_id, created_at);
        CREATE INDEX IF NOT EXISTS %I
          ON %I (user_id, field, created_at);
      `,
        this.table,
        this.historyTable,
        `${this.historyTable}_user_created_idx`,
        this.historyTable,
        `${this.historyTable}_user_field_created_idx`,
        this.historyTable
      ));
    } finally {
      client.release();
    }
  }

  async get(userId: string): Promise<StorageRecord | null> {
    const result = await this.pool.query(
      format(`SELECT profile, provenance, version FROM %I WHERE user_id = $1`, this.table),
      [userId]
    );
    if (result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
      profile: row.profile ?? {},
      provenance: row.provenance ?? {},
      etag: String(row.version),
    };
  }

  async set(
    userId: string,
    profile: Record<string, unknown>,
    provenance: Record<string, Provenance>,
    options?: StorageSetOptions,
    history?: HistoryEntry[]
  ): Promise<{ etag: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      if (options?.etag && !options.force) {
        const res = await client.query(
          format(`UPDATE %I
             SET profile = $2, provenance = $3, version = version + 1, updated_at = now()
             WHERE user_id = $1 AND version = $4
             RETURNING version`, this.table),
          [userId, profile, provenance, Number(options.etag)]
        );
        if (res.rowCount === 0) {
          throw new ConcurrencyError("etag mismatch");
        }
        if (history && history.length > 0) {
          for (const entry of history) {
            await client.query(
              format(`INSERT INTO %I (user_id, field, entry) VALUES ($1, $2, $3)`, this.historyTable),
              [userId, entry.field, entry]
            );
          }
        }
        await client.query("COMMIT");
        return { etag: String(res.rows[0].version) };
      }

      const res = await client.query(
        format(`INSERT INTO %I (user_id, profile, provenance)
           VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
           SET profile = EXCLUDED.profile,
               provenance = EXCLUDED.provenance,
               version = %I.version + 1,
               updated_at = now()
         RETURNING version`, this.table, this.table),
        [userId, profile, provenance]
      );
      if (history && history.length > 0) {
        for (const entry of history) {
          await client.query(
            format(`INSERT INTO %I (user_id, field, entry) VALUES ($1, $2, $3)`, this.historyTable),
            [userId, entry.field, entry]
          );
        }
      }
      await client.query("COMMIT");
      return { etag: String(res.rows[0].version) };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async appendHistory(userId: string, entry: HistoryEntry): Promise<void> {
    await this.pool.query(
      format(`INSERT INTO %I (user_id, field, entry) VALUES ($1, $2, $3)`, this.historyTable),
      [userId, entry.field, entry]
    );
  }

  async getHistory(userId: string, options?: StorageHistoryOptions): Promise<StorageHistoryResult> {
    const limit = options?.limit ?? 50;
    const cursorId = options?.cursor ? Number(options.cursor) : 0;
    const params: Array<string | number> = [userId, cursorId];
    let fieldClause = "";
    if (options?.field) {
      fieldClause = "AND field = $3";
      params.push(options.field);
    }

    const res = await this.pool.query(
      format(`SELECT id, entry FROM %I
         WHERE user_id = $1 AND id > $2 ${fieldClause}
         ORDER BY id ASC
         LIMIT $${fieldClause ? 4 : 3}`, this.historyTable),
      fieldClause ? [...params, limit + 1] : [...params, limit + 1]
    );

    const rows = res.rows.slice(0, limit);
    const entries = rows.map((r: { id: number; entry: HistoryEntry }) => r.entry);
    const lastRow = rows[rows.length - 1];
    const nextCursor = res.rows.length > limit && lastRow ? String(lastRow.id) : undefined;
    return { entries, nextCursor };
  }

  async delete(userId: string): Promise<void> {
    await this.pool.query(format(`DELETE FROM %I WHERE user_id = $1`, this.historyTable), [userId]);
    await this.pool.query(format(`DELETE FROM %I WHERE user_id = $1`, this.table), [userId]);
  }

  async healthCheck(): Promise<boolean> {
    const res = await this.pool.query("SELECT 1");
    return res.rowCount === 1;
  }
}

