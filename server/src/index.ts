import { loadConfig } from './config.js';
import { createDatabase } from './db/index.js';
import { createApp } from './app.js';
import { ensureStorage } from './services/storage-state.js';

const config = loadConfig();
const db = createDatabase(config);
await db.migrate();
await ensureStorage(db, config);
const { app, background } = createApp(db, config);
const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`GRT API listening on ${config.HOST}:${config.PORT}`);
  background.start();
});
server.requestTimeout = 15 * 60 * 1000;
async function shutdown() {
  server.close(async () => {
    await background.stop();
    await db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 30000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
