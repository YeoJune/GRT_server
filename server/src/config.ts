import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

export const root = fileURLToPath(new URL('../..', import.meta.url));
dotenv.config({ path: path.join(root, '.env'), quiet: true });
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: bool.default('false'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  DB_CLIENT: z.enum(['sqlite', 'pg']).default('sqlite'),
  SQLITE_FILENAME: z.string().default('./data/grt.sqlite'),
  DATABASE_URL: z.string().default(''),
  DB_SSL: bool.default('false'),
  DB_SSL_CA_FILE: z.string().default(''),
  SESSION_MAX_SECONDS: z.coerce.number().int().positive().default(28800),
  SESSION_IDLE_SECONDS: z.coerce.number().int().positive().default(1800),
  LEASE_SECONDS: z.coerce.number().int().positive().default(180),
  HEARTBEAT_SECONDS: z.coerce.number().int().positive().default(30),
  MAX_JSON_BYTES: z.coerce.number().int().positive().default(1048576),
  MAX_ARTIFACT_BYTES: z.coerce.number().int().positive().default(1073741824),
  MAX_EXPORT_BYTES: z.coerce.number().int().positive().default(2147483648),
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_DIRECTORY: z.string().default('./data/artifacts'),
  STORAGE_SIGNING_KEY: z
    .string()
    .min(32, 'Set STORAGE_SIGNING_KEY to a random key of at least 32 characters'),
  SIGNED_URL_SECONDS: z.coerce.number().int().min(1).max(300).default(300),
  AWS_REGION: z.string().default('ap-northeast-2'),
  S3_BUCKET: z.string().default(''),
  S3_PREFIX: z.string().default('grt/'),
  S3_BUDGET_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(1000000000000),
  VAST_API_KEY: z.string().default(''),
});
export type Config = z.infer<typeof envSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid environment: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  const c = result.data;
  if (c.DB_CLIENT === 'pg' && !c.DATABASE_URL) throw new Error('DATABASE_URL is required for pg');
  if (c.STORAGE_DRIVER === 's3' && !c.S3_BUCKET) throw new Error('S3_BUCKET is required for s3');
  if (c.NODE_ENV === 'production' && (!c.COOKIE_SECURE || !c.APP_ORIGIN.startsWith('https://'))) {
    throw new Error('Production requires HTTPS APP_ORIGIN and COOKIE_SECURE=true');
  }
  c.APP_ORIGIN = new URL(c.APP_ORIGIN).origin;
  return c;
}
export const resolveRoot = (p: string) => path.resolve(root, p);
