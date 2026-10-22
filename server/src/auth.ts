import argon2 from 'argon2';
import type { NextFunction, Request, Response } from 'express';
import type { Config } from './config.js';
import type { Database, Store } from './db/index.js';
import { assert, equal, hash, id, now, secret } from './util.js';

export interface Principal {
  kind: 'write' | 'read-only';
  expires_at: string;
  token_id?: string;
  session_id?: string;
  method: 'password' | 'token';
  csrf_token?: string;
}
declare global {
  namespace Express {
    interface Request {
      auth: Principal;
      requestId: string;
    }
  }
}
export const cookieName = 'grt_session';
export const cookieOptions = (c: Config) => ({
  httpOnly: true,
  secure: c.COOKIE_SECURE,
  sameSite: 'strict' as const,
  path: '/',
});
export async function verifyToken(tx: Store, raw: string) {
  const [prefix] = raw.split('.');
  const token = await tx.get('tokens', prefix);
  assert(
    token &&
      equal(token.secret_hash, hash(raw)) &&
      !token.revoked_at &&
      Date.parse(token.expires_at) > Date.now(),
    401,
    'unauthorized',
    'Token expired, revoked, or invalid',
  );
  await tx.put('tokens', { ...token, last_used_at: now() });
  return token;
}
export async function mintToken(
  tx: Store,
  input: { name: string; kind: string; expires_at: string },
) {
  assert(
    Date.parse(input.expires_at) > Date.now(),
    422,
    'invalid_expiry',
    'Expiry must be in the future',
  );
  const tokenId = id('tok');
  const raw = `${tokenId}.${secret()}`;
  const token = {
    id: tokenId,
    created_at: now(),
    ...input,
    prefix: raw.slice(0, tokenId.length + 5),
    secret_hash: hash(raw),
    last_used_at: null,
    revoked_at: null,
  };
  await tx.put('tokens', token);
  return { token, raw };
}
export async function verifyLogin(tx: Store, input: any) {
  if (input.token) {
    const t = await verifyToken(tx, input.token);
    return { kind: t.kind, method: 'token' as const, token_id: t.id, expires_at: t.expires_at };
  }
  const account = await tx.get('accounts', 'owner');
  // A fixed Argon2 workload on missing/wrong usernames limits account timing differences.
  const valid = account
    ? await argon2.verify(account.password_hash, input.password || '')
    : (await argon2.hash(input.password || '', { type: argon2.argon2id }), false);
  assert(
    valid && account?.username === input.username,
    401,
    'unauthorized',
    'Invalid account or password',
  );
  return { kind: 'write' as const, method: 'password' as const };
}
export function authentication(db: Database, c: Config) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    req.auth = await db.write(async (tx) => {
      if (req.headers.authorization) {
        const match = /^Bearer ([^\s]+)$/.exec(req.headers.authorization);
        assert(match, 401, 'unauthorized', 'Expected Bearer token');
        const t = await verifyToken(tx, match[1]);
        return { kind: t.kind, expires_at: t.expires_at, token_id: t.id, method: 'token' };
      }
      const raw = req.cookies[cookieName];
      assert(typeof raw === 'string', 401, 'unauthorized', 'Login required');
      const s = await tx.get('sessions', hash(raw));
      assert(
        s &&
          Date.parse(s.expires_at) > Date.now() &&
          Date.parse(s.last_used_at) + c.SESSION_IDLE_SECONDS * 1000 > Date.now(),
        401,
        'unauthorized',
        'Session expired',
      );
      let expires = s.expires_at;
      if (s.token_id) {
        const t = await tx.get('tokens', s.token_id);
        assert(
          t && !t.revoked_at && Date.parse(t.expires_at) > Date.now(),
          401,
          'unauthorized',
          'Underlying token expired or revoked',
        );
        await tx.put('tokens', { ...t, last_used_at: now() });
        expires = new Date(Math.min(Date.parse(expires), Date.parse(t.expires_at))).toISOString();
      }
      await tx.put('sessions', { ...s, last_used_at: now() });
      return {
        kind: s.kind,
        method: s.method,
        expires_at: expires,
        token_id: s.token_id,
        session_id: s.id,
        csrf_token: s.csrf_token,
      };
    });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.auth.session_id) {
      assert(
        req.get('origin') === c.APP_ORIGIN,
        403,
        'invalid_origin',
        'Origin does not match APP_ORIGIN',
      );
      assert(req.get('x-csrf-token') === req.auth.csrf_token, 403, 'csrf', 'CSRF token required');
    }
    next();
  };
}
export const writeOnly = (req: Request, _res: Response, next: NextFunction) => {
  assert(req.auth.kind === 'write', 403, 'forbidden', 'Write permission required');
  next();
};
export async function audit(
  tx: Store,
  req: Request,
  action: string,
  details: Record<string, unknown> = {},
) {
  await tx.put('audit', {
    id: id('audit'),
    created_at: now(),
    action,
    actor: req.auth?.token_id || req.auth?.session_id || 'anonymous',
    request_id: req.requestId,
    ...details,
  });
}
export async function setupAccount(
  db: Database,
  username: string,
  password: string,
  reset = false,
  revokeTokens = false,
) {
  assert(password.length >= 12, 422, 'weak_password', 'Use at least 12 characters');
  assert(
    username.length > 0 && username.length <= 150,
    422,
    'invalid_username',
    'Invalid username',
  );
  const password_hash = await argon2.hash(password, { type: argon2.argon2id });
  await db.write(async (tx) => {
    const existing = await tx.get('accounts', 'owner');
    assert(reset || !existing, 409, 'account_exists', 'Owner exists; use account:reset');
    await tx.put('accounts', {
      id: 'owner',
      created_at: existing?.created_at || now(),
      username,
      password_hash,
    });
    for (const s of await tx.list('sessions')) await tx.remove('sessions', s.id);
    if (revokeTokens)
      for (const t of await tx.list('tokens')) await tx.put('tokens', { ...t, revoked_at: now() });
  });
}
