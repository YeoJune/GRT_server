import { loadConfig } from './config.js';
import { createDatabase } from './db/index.js';
import { setupAccount } from './auth.js';

const command = process.argv[2];
const config = loadConfig();
const db = createDatabase(config);
try {
  await db.migrate();
  if (command === 'setup' || command === 'reset') {
    await setupAccount(
      db,
      process.env.OWNER_USERNAME || 'owner',
      process.env.OWNER_PASSWORD || '',
      command === 'reset',
      process.env.RESET_REVOKE_TOKENS === 'true',
    );
    console.log(
      `Owner ${command === 'setup' ? 'created' : 'reset'}; all previous browser sessions revoked.`,
    );
  } else if (command === 'migrate') console.log('Database migrations completed.');
  else throw new Error('Expected migrate, setup, or reset');
} catch (error: any) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
