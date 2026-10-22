import type { Knex } from 'knex';
export const tables = [
  'accounts',
  'sessions',
  'tokens',
  'settings',
  'schemas',
  'queues',
  'workers',
  'jobs',
  'attempts',
  'artifacts',
  'exports',
  'requests',
  'audit',
] as const;
export async function up(db: Knex) {
  await db.schema.createTable('write_lock', (t) => {
    t.integer('id').primary();
  });
  await db('write_lock').insert({ id: 1 });
  for (const name of tables) {
    await db.schema.createTable(name, (t) => {
      t.string('id', 200).primary();
      t.text('body').notNullable();
      t.string('created_at', 30).notNullable().index();
    });
  }
}
export async function down(db: Knex) {
  for (const name of [...tables].reverse()) await db.schema.dropTableIfExists(name);
  await db.schema.dropTableIfExists('write_lock');
}
