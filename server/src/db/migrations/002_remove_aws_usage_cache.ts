import type { Knex } from 'knex';

export async function up(db: Knex) {
  await db('settings').where({ id: 'aws-download-usage' }).delete();
}

export async function down() {
  // This was a disposable API cache; no experiment or user settings need restoring.
}
