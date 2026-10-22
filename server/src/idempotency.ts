import type { Request, Response } from 'express';
import type { Database, Store } from './db/index.js';
import { assert, canonical, hash, now } from './util.js';

type Reply = { status?: number; body?: any; headers?: Record<string, string> };
// Lease secrets are never stored in response caches. The original lease is needed to
// recover execution permission after a lost response; otherwise confirm termination and retry.
function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([k]) =>
            ![
              'lease_token',
              'token',
              'url',
              'upload_url',
              'download_url',
              'csrf_token',
              'secret_hash',
              'lease_hash',
            ].includes(k),
        )
        .map(([k, v]) => [k, redact(v)]),
    );
  return value;
}
export async function mutation(
  db: Database,
  req: Request,
  res: Response,
  fn: (tx: Store) => Promise<Reply>,
  options: { required?: boolean; oneTime?: boolean } = {},
) {
  const key = req.get('idempotency-key');
  assert(
    key || !options.required,
    422,
    'idempotency_key_required',
    'Idempotency-Key header required',
  );
  assert(
    !key || /^[a-zA-Z0-9_.:-]{8,128}$/.test(key),
    422,
    'invalid_idempotency_key',
    'Use an 8–128 character request ID',
  );
  const requestHash = hash(
    canonical({ path: req.originalUrl.split('?')[0], method: req.method, body: req.body ?? {} }),
  );
  const reply = await db.write(async (tx) => {
    // Single owner namespace intentionally survives API token replacement.
    const record = key ? await tx.get('requests', key) : undefined;
    if (record) {
      assert(
        record.request_hash === requestHash,
        409,
        'idempotency_conflict',
        'Request ID was used with a different path or body',
      );
      assert(
        !options.oneTime,
        409,
        'secret_already_issued',
        'Secret was already issued; revoke the recorded ID and issue a new one',
      );
      return {
        ...record.reply,
        ...(record.lease_issued
          ? { body: { ...record.reply.body, lease_recovery_required: true } }
          : {}),
        headers: { ...record.reply.headers, 'Idempotency-Replayed': 'true' },
      } as Reply;
    }
    const result = await fn(tx);
    if (key)
      await tx.put('requests', {
        id: key,
        created_at: now(),
        request_hash: requestHash,
        reply: redact(result),
        lease_issued: JSON.stringify(result.body || {}).includes('\"lease_token\"'),
        state: result.status === 202 ? 'accepted' : 'completed',
      });
    return result;
  });
  for (const [k, v] of Object.entries(reply.headers || {})) res.set(k, v);
  if (reply.status === 204) res.status(204).end();
  else res.status(reply.status || 200).json(reply.body ?? null);
}
