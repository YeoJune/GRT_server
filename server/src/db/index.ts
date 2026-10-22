import knex, { type Knex } from 'knex';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { resolveRoot } from '../config.js';
import * as initial from './migrations/001_initial.js';
import { now } from '../util.js';

export type RecordData = { id: string; created_at: string; [key: string]: any };
type Table = (typeof initial.tables)[number];
export class Store {
  constructor(public sql: Knex | Knex.Transaction) {}
  async get(table: Table, id: string): Promise<RecordData | undefined> {
    const row = await this.sql(table).where({ id }).first();
    return row ? JSON.parse(row.body) : undefined;
  }
  async list(table: Table): Promise<RecordData[]> {
    return (await this.sql(table).orderBy('id', 'desc')).map((row) => JSON.parse(row.body));
  }
  async put<T extends RecordData>(table: Table, data: T): Promise<T> {
    const body = JSON.stringify(data);
    await this.sql(table)
      .insert({ id: data.id, created_at: data.created_at, body })
      .onConflict('id')
      .merge({ body });
    return data;
  }
  async remove(table: Table, id: string) {
    await this.sql(table).where({ id }).delete();
  }
}
export class Database extends Store {
  declare sql: Knex;
  async migrate() {
    await this.sql.migrate.latest({
      migrationSource: {
        getMigrations: async () => ['001_initial'],
        getMigrationName: (m: string) => m,
        getMigration: async () => initial,
      },
    });
    await this.write(async (tx) => {
      if (!(await tx.get('settings', 'settings')))
        await tx.put('settings', {
          id: 'settings',
          created_at: now(),
          max_attempt_seconds: 172800,
          upload_margin_seconds: 300,
        });
    });
  }
  // One transaction gate serializes claims and idempotency on both SQLite and PostgreSQL.
  // SQLite uses one connection; PostgreSQL locks the singleton row until commit.
  async write<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    return this.sql.transaction(async (trx) => {
      if (this.sql.client.config.client === 'pg')
        await trx('write_lock').where({ id: 1 }).forUpdate().first();
      return fn(new Store(trx));
    });
  }
  async close() {
    await this.sql.destroy();
  }
}
export function createDatabase(c: Config) {
  if (c.DB_CLIENT === 'sqlite')
    mkdirSync(path.dirname(resolveRoot(c.SQLITE_FILENAME)), { recursive: true, mode: 0o700 });
  const db = knex(
    c.DB_CLIENT === 'sqlite'
      ? {
          client: 'better-sqlite3',
          connection: { filename: resolveRoot(c.SQLITE_FILENAME) },
          useNullAsDefault: true,
          pool: {
            min: 1,
            max: 1,
            afterCreate(conn: any, done: Function) {
              conn.pragma('journal_mode = WAL');
              conn.pragma('foreign_keys = ON');
              conn.pragma('busy_timeout = 5000');
              done(null, conn);
            },
          },
        }
      : {
          client: 'pg',
          connection: {
            connectionString: c.DATABASE_URL,
            ssl: c.DB_SSL
              ? {
                  rejectUnauthorized: true,
                  ...(c.DB_SSL_CA_FILE
                    ? { ca: readFileSync(resolveRoot(c.DB_SSL_CA_FILE), 'utf8') }
                    : {}),
                }
              : false,
          },
          pool: { min: 0, max: 10 },
        },
  );
  return new Database(db);
}
