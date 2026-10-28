import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { ZodError } from 'zod/v3';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Config } from './config.js';
import { root } from './config.js';
import type { Database } from './db/index.js';
import { ApiError, id } from './util.js';
import { authentication } from './auth.js';
import { loginRoutes, accountRoutes } from './routes/account.js';
import { experimentRoutes } from './routes/experiments.js';
import { artifactRoutes, transferRoutes } from './routes/artifacts.js';
import { providerRoutes } from './routes/providers.js';
import { storageRoutes } from './routes/storage.js';
import { Storage } from './services/storage.js';
import { Background } from './services/background.js';

export function createApp(db: Database, c: Config) {
  const app = express();
  const storage = new Storage(c);
  const background = new Background(db, storage);
  app.disable('x-powered-by');
  if (c.TRUST_PROXY) app.set('trust proxy', c.TRUST_PROXY);
  app.use(
    helmet({ strictTransportSecurity: c.NODE_ENV === 'production' ? { maxAge: 31536000 } : false }),
  );
  app.use((req, res, next) => {
    req.requestId = id('req');
    res.set('X-Request-ID', req.requestId);
    if (req.path.startsWith('/v1')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/healthz', async (_req, res) => {
    await db.sql.raw('select 1');
    res.json({ status: 'ok' });
  });
  // Stream raw file transfers before the JSON parser; signed URLs are short-lived credentials.
  app.use('/v1', transferRoutes(db, storage));
  app.use(express.json({ limit: c.MAX_JSON_BYTES }));
  app.use(cookieParser());
  app.use('/v1', loginRoutes(db, c));
  app.use(
    '/v1',
    authentication(db, c),
    accountRoutes(db, c),
    experimentRoutes(db, c),
    artifactRoutes(db, c, storage),
    providerRoutes(c),
    storageRoutes(c, storage),
  );
  app.use('/v1', (_req, _res, next) => next(new ApiError(404, 'not_found', 'API route not found')));
  const web = path.join(root, 'web/dist');
  if (existsSync(path.join(web, 'index.html'))) {
    app.use(express.static(web, { index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(web, 'index.html')));
  }
  app.use((_req, _res, next) => next(new ApiError(404, 'not_found', 'Route not found')));
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    const status =
      err instanceof ZodError
        ? 422
        : err instanceof ApiError
          ? err.status
          : err.type === 'entity.too.large'
            ? 413
            : err.type === 'entity.parse.failed'
              ? 422
              : 500;
    const code =
      err instanceof ZodError
        ? 'validation_error'
        : err instanceof ApiError
          ? err.code
          : status === 413
            ? 'payload_too_large'
            : status === 422
              ? 'invalid_json'
              : 'internal_error';
    if (status === 500)
      console.error(JSON.stringify({ event: 'request.error', request_id: req.requestId, code }));
    res.status(status).json({
      code,
      message:
        status === 500
          ? 'Internal server error'
          : err instanceof ZodError
            ? 'Invalid request fields'
            : err.message,
      request_id: req.requestId,
      retryable: status >= 500 || status === 429,
      field_errors:
        err instanceof ZodError
          ? err.issues.map((i) => ({ path: i.path, message: i.message }))
          : err.field_errors || [],
    });
  });
  return { app, storage, background };
}
