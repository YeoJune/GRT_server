import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
const directory = await mkdtemp(path.join(tmpdir(), 'grt-browser-test-'));
const env = {
  ...process.env,
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '3100',
  APP_ORIGIN: 'http://127.0.0.1:3100',
  COOKIE_SECURE: 'false',
  DB_CLIENT: 'sqlite',
  SQLITE_FILENAME: path.join(directory, 'database.sqlite'),
  STORAGE_DRIVER: 'local',
  STORAGE_DIRECTORY: path.join(directory, 'files'),
  STORAGE_SIGNING_KEY: 'browser-test-key-'.repeat(4),
  OWNER_USERNAME: 'owner',
  OWNER_PASSWORD: 'browser-test-password-123',
};
const setup = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/manage.ts', 'setup'], {
  env,
  stdio: 'inherit',
});
if (setup.status !== 0) process.exit(1);
const child = spawn(process.execPath, ['server/dist/index.js'], { env, stdio: 'inherit' });
async function stop() {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => {
  process.exitCode = code || 0;
});
