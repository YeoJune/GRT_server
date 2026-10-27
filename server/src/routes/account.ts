import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod/v3';
import argon2 from 'argon2';
import type { Database } from '../db/index.js';
import type { Config } from '../config.js';
import {
  audit,
  cookieName,
  cookieOptions,
  mintToken,
  verifyLogin,
  verifyToken,
  writeOnly,
} from '../auth.js';
import { assert, hash, now, page, publicToken, secret, secondsFromNow } from '../util.js';
import { kind, name, time } from '../validation.js';
import { mutation } from '../idempotency.js';

export function loginRoutes(db: Database, c: Config) {
  const r = Router();
  r.post(
    '/sessions',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (req, res) =>
        res.status(429).json({
          code: 'rate_limited',
          message: 'Too many login attempts',
          request_id: req.requestId,
          retryable: true,
          field_errors: [],
        }),
    }),
    async (req, res) => {
      assert(
        req.get('origin') === undefined || req.get('origin') === c.APP_ORIGIN,
        403,
        'invalid_origin',
        'Origin does not match APP_ORIGIN',
      );
      const input = z
        .union([
          z.object({ username: name, password: z.string().min(1).max(1024) }).strict(),
          z.object({ token: z.string().min(1).max(512) }).strict(),
        ])
        .parse(req.body);
      const raw = secret();
      const session = await db
        .write(async (tx) => {
          const p = await verifyLogin(tx, input);
          const expires_at = new Date(
            Math.min(
              Date.now() + c.SESSION_MAX_SECONDS * 1000,
              p.method === 'token' ? Date.parse(p.expires_at) : Infinity,
            ),
          ).toISOString();
          const session = {
            ...p,
            id: hash(raw),
            created_at: now(),
            last_used_at: now(),
            expires_at,
            csrf_token: secret(),
          };
          await tx.put('sessions', session);
          await audit(tx, req, 'session.login', { method: p.method });
          return session;
        })
        .catch(async (error) => {
          await db.write((tx) =>
            audit(tx, req, 'session.login_failed', {
              method: 'token' in input ? 'token' : 'password',
            }),
          );
          throw error;
        });
      res.cookie(cookieName, raw, {
        ...cookieOptions(c),
        maxAge: Date.parse(session.expires_at) - Date.now(),
      });
      res.status(201).json({
        kind: session.kind,
        expires_at: session.expires_at,
        csrf_token: session.csrf_token,
      });
    },
  );
  return r;
}
export function accountRoutes(db: Database, c: Config) {
  const r = Router();
  r.get('/me', async (req, res) =>
    res.json({
      token_name: req.auth.token_id ? (await db.get('tokens', req.auth.token_id))?.name : null,
      kind: req.auth.kind,
      expires_at: req.auth.expires_at,
      token_id: req.auth.token_id ?? null,
      csrf_token: req.auth.csrf_token,
      api_version: 'v1',
      server_version: '0.1.0',
    }),
  );
  r.delete('/sessions/current', async (req, res) => {
    if (req.auth.session_id) await db.write((tx) => tx.remove('sessions', req.auth.session_id!));
    res.clearCookie(cookieName, cookieOptions(c)).status(204).end();
  });
  r.post('/account/actions', writeOnly, async (req, res) => {
    const input = z
      .object({
        action: z.enum(['change_password', 'revoke_sessions']),
        password: z.string().max(1024).optional(),
        token: z.string().max(512).optional(),
        new_password: z.string().min(12).max(1024).optional(),
      })
      .strict()
      .parse(req.body);
    await db.write(async (tx) => {
      const owner = await tx.get('accounts', 'owner');
      if (req.auth.session_id) {
        if (req.auth.method === 'password')
          assert(
            owner && input.password && (await argon2.verify(owner.password_hash, input.password)),
            401,
            'reauthentication_required',
            'Current password required',
          );
        else {
          const t = await verifyToken(tx, input.token || '');
          assert(
            t.id === req.auth.token_id,
            401,
            'reauthentication_required',
            'Original token required',
          );
        }
      }
      if (input.action === 'change_password') {
        assert(owner && input.new_password, 422, 'validation_error', 'new_password required');
        await tx.put('accounts', {
          ...owner,
          password_hash: await argon2.hash(input.new_password, { type: argon2.argon2id }),
        });
      }
      for (const s of await tx.list('sessions')) await tx.remove('sessions', s.id);
      await audit(tx, req, `account.${input.action}`);
    });
    res.clearCookie(cookieName, cookieOptions(c)).status(204).end();
  });
  r.get('/tokens', async (req, res) => page(req, res, (await db.list('tokens')).map(publicToken)));
  r.post('/tokens', writeOnly, async (req, res) => {
    const input = z
      .object({ name, kind, expires_at: time.default(() => secondsFromNow(604800)) })
      .strict()
      .parse(req.body);
    await mutation(
      db,
      req,
      res,
      async (tx) => {
        const { token, raw } = await mintToken(tx, input);
        await audit(tx, req, 'token.create', { token_id: token.id });
        return { status: 201, body: { ...publicToken(token), token: raw } };
      },
      { required: true, oneTime: true },
    );
  });
  r.patch('/tokens/:id', writeOnly, async (req, res) => {
    const input = z.object({ expires_at: time }).strict().parse(req.body);
    await mutation(db, req, res, async (tx) => {
      const token = await tx.get('tokens', String(req.params.id));
      assert(token, 404, 'not_found', 'Token not found');
      assert(
        !token.revoked_at && Date.parse(token.expires_at) > Date.now(),
        409,
        'inactive_token',
        'Expired/revoked tokens cannot be restored',
      );
      assert(
        Date.parse(input.expires_at) > Date.now(),
        422,
        'invalid_expiry',
        'Expiry must be in the future',
      );
      const updated = await tx.put('tokens', { ...token, ...input });
      await audit(tx, req, 'token.expiry', { token_id: token.id });
      return { body: publicToken(updated) };
    });
  });
  r.delete('/tokens/:id', writeOnly, async (req, res) =>
    mutation(db, req, res, async (tx) => {
      const token = await tx.get('tokens', String(req.params.id));
      assert(token, 404, 'not_found', 'Token not found');
      await tx.put('tokens', { ...token, revoked_at: token.revoked_at || now() });
      await audit(tx, req, 'token.revoke', { token_id: token.id });
      return { status: 204 };
    }),
  );
  r.get('/settings', async (_req, res) => res.json(await db.get('settings', 'settings')));
  r.patch('/settings', writeOnly, async (req, res) => {
    const input = z
      .object({
        max_attempt_seconds: z.number().int().positive().max(604800),
        upload_margin_seconds: z.number().int().min(30).max(3600),
      })
      .strict()
      .partial()
      .refine((v) => Object.keys(v).length > 0)
      .parse(req.body);
    await mutation(db, req, res, async (tx) => {
      const settings = await tx.get('settings', 'settings');
      const updated = await tx.put('settings', { ...settings!, ...input });
      await audit(tx, req, 'settings.update', { fields: Object.keys(input) });
      return { body: updated };
    });
  });
  r.get('/requests/:id', async (req, res) => {
    const request = await db.get('requests', String(req.params.id));
    assert(request, 404, 'not_found', 'Request not found');
    const { request_hash, ...safe } = request;
    if (safe.state === 'accepted') {
      const reference = safe.reply.body;
      const resource = reference?.attempt_id
        ? await db.get('attempts', reference.attempt_id)
        : reference?.id?.startsWith('art_')
          ? await db.get('artifacts', reference.id)
          : reference?.id?.startsWith('exp_')
            ? await db.get('exports', reference.id)
            : undefined;
      if (resource) {
        safe.resource_status = resource.status;
        if (!['finalizing', 'verifying', 'preparing'].includes(resource.status))
          safe.state = 'completed';
      }
    }
    res.json(safe);
  });
  r.get('/audit', async (req, res) => page(req, res, await db.list('audit')));
  return r;
}
