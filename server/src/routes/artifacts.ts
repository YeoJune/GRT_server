import { Router } from 'express';
import { z } from 'zod/v3';
import type { Database } from '../db/index.js';
import type { Config } from '../config.js';
import { authentication, writeOnly } from '../auth.js';
import { mutation } from '../idempotency.js';
import { assert, canonical, hash, id, now, secondsFromNow } from '../util.js';
import { name } from '../validation.js';
import type { Storage } from '../services/storage.js';

export function artifactRoutes(db: Database, c: Config, storage: Storage) {
  const r = Router();
  const uploadLink = (a: any, expires_at: string) => ({
    url: `${c.APP_ORIGIN}/v1/artifacts/uploads/${a.id}/content`,
    expires_at,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  const prepared = (a: any) =>
    a.kind === 'dataset' &&
    a.status === 'verified' &&
    a.extensions?.cache_format === 'grt.prepared/1';
  r.get('/datasets', async (_req, res) =>
    res.json({ data: (await db.list('artifacts')).filter(prepared) }),
  );
  r.get('/datasets/:sha256', async (req, res) => {
    const sha = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(req.params.sha256);
    const found = (await db.list('artifacts')).find(
      (a) => prepared(a) && a.extensions.manifest_sha256 === sha,
    );
    assert(found, 404, 'not_found', 'Prepared dataset is not cached');
    res.json(found);
  });
  const uploadInput = z
    .object({
      name: name.refine((v) => !/[\\/\r\n]/.test(v), 'Use a filename, not a path'),
      job_id: z.string().nullable().default(null),
      attempt_id: z.string().nullable().default(null),
      kind: z.enum(['report', 'config', 'provenance', 'checkpoint', 'log', 'result', 'dataset']),
      size_bytes: z.number().int().min(0).max(c.MAX_ARTIFACT_BYTES),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      format: name,
      format_version: name,
      extensions: z.record(z.string(), z.unknown()).default({}),
    })
    .strict();
  r.post('/artifacts/uploads', writeOnly, async (req, res) => {
    const refresh = z.object({ upload_id: z.string() }).strict().safeParse(req.body);
    if (refresh.success) {
      const a = await db.get('artifacts', refresh.data.upload_id);
      assert(a, 404, 'not_found', 'Upload not found');
      assert(
        a.status === 'reserved',
        409,
        'upload_closed',
        'Only reserved uploads can refresh URLs',
      );
      return res.json({ ...a, upload: uploadLink(a, req.auth.expires_at) });
    }
    const input = uploadInput.parse(req.body);
    await mutation(
      db,
      req,
      res,
      async (tx) => {
        if (input.kind === 'dataset' && input.extensions.cache_format === 'grt.prepared/1') {
          z.string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(input.extensions.manifest_sha256);
          assert(
            !input.job_id && !input.attempt_id,
            422,
            'dataset_link',
            'Datasets are shared inputs',
          );
          const previous = (await tx.list('artifacts')).find(
            (a) =>
              a.kind === 'dataset' &&
              ['reserved', 'verifying', 'verified'].includes(a.status) &&
              a.extensions.cache_format === 'grt.prepared/1' &&
              a.extensions.manifest_sha256 === input.extensions.manifest_sha256,
          );
          if (previous) {
            assert(
              previous.sha256 === input.sha256 && previous.size_bytes === input.size_bytes,
              409,
              'cache_conflict',
              'The same manifest must preserve the same prepared archive bytes',
            );
            return { body: previous };
          }
        }
        if (input.kind !== 'dataset') {
          assert(
            input.job_id && input.attempt_id,
            422,
            'attempt_required',
            'Output artifacts require job_id and attempt_id',
          );
          const job = await tx.get('jobs', input.job_id);
          const attempt = await tx.get('attempts', input.attempt_id);
          assert(
            job &&
              attempt?.job_id === job.id &&
              job.active_attempt_id === attempt.id &&
              attempt.status === 'running',
            409,
            'stale_attempt',
            'Output upload must belong to the current running attempt',
          );
        } else
          assert(
            !input.job_id && !input.attempt_id,
            422,
            'dataset_link',
            'Datasets are shared inputs without job/attempt',
          );
        const a = await tx.put('artifacts', {
          ...input,
          id: id('art'),
          created_at: now(),
          status: 'reserved',
          object_version: null,
          error: null,
        });
        return {
          status: 201,
          body: { ...a, upload: uploadLink(a, req.auth.expires_at) },
        };
      },
      { required: true },
    );
  });
  r.get('/artifacts/uploads/:id', async (req, res) => {
    const a = await db.get('artifacts', String(req.params.id));
    assert(a, 404, 'not_found', 'Upload not found');
    res.json(a);
  });
  r.post('/artifacts/uploads/:id/complete', writeOnly, async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    await mutation(
      db,
      req,
      res,
      async (tx) => {
        const a = await tx.get('artifacts', String(req.params.id));
        assert(a, 404, 'not_found', 'Upload not found');
        if (a.status === 'verified') return { body: a };
        assert(
          !storage.receiving.has(a.id),
          429,
          'upload_in_progress',
          'Upload is still in progress',
        );
        assert(
          ['reserved', 'verifying'].includes(a.status),
          409,
          'upload_closed',
          'Upload verification failed; reserve a new upload',
        );
        return {
          status: 202,
          body: await tx.put('artifacts', {
            ...a,
            status: 'verifying',
            verification_requested_at: now(),
          }),
        };
      },
      { required: true },
    );
  });
  r.get('/artifacts/:id/download', async (req, res) => {
    const a = await db.get('artifacts', String(req.params.id));
    assert(a?.status === 'verified', 404, 'not_found', 'Verified artifact not found');
    res.json({
      artifact_id: a.id,
      sha256: a.sha256,
      size_bytes: a.size_bytes,
      ...(await storage.downloadUrl(a, req.auth.expires_at)),
    });
  });
  r.post('/exports', async (req, res) => {
    const input = z
      .object({
        job_ids: z.array(z.string()).max(50).default([]),
        artifact_ids: z.array(z.string()).max(1000).default([]),
      })
      .strict()
      .parse(req.body);
    await mutation(
      db,
      req,
      res,
      async (tx) => {
        const all = await tx.list('artifacts');
        const artifacts = all.filter(
          (a) =>
            a.status === 'verified' &&
            (input.artifact_ids.includes(a.id) || input.job_ids.includes(a.job_id)),
        );
        assert(
          input.artifact_ids.every((aid) => artifacts.some((a) => a.id === aid)),
          422,
          'unverified_artifact',
          'Every selected artifact must be verified',
        );
        for (const jid of input.job_ids) {
          const job = await tx.get('jobs', jid);
          assert(job && job.status !== 'deleting', 422, 'job_not_found', 'Selected job not found');
        }
        assert(
          artifacts.length > 0 && artifacts.length <= 1000,
          422,
          'empty_export',
          'Select 1–1000 verified files',
        );
        assert(
          artifacts.reduce((s, a) => s + a.size_bytes, 0) <= c.MAX_EXPORT_BYTES,
          413,
          'export_too_large',
          'Selected files exceed export size limit',
        );
        const fingerprint = hash(
          canonical(
            artifacts
              .map((a) => ({ id: a.id, sha256: a.sha256, object_version: a.object_version }))
              .sort((a, b) => a.id.localeCompare(b.id)),
          ),
        );
        const existing = (await tx.list('exports')).find(
          (e) =>
            e.fingerprint === fingerprint &&
            ['preparing', 'ready'].includes(e.status) &&
            Date.parse(e.expires_at) > Date.now(),
        );
        if (existing) return { status: existing.status === 'ready' ? 200 : 202, body: existing };
        assert(
          (await tx.list('exports')).filter((e) => e.status === 'preparing').length < 2,
          429,
          'export_busy',
          'At most two exports can be preparing',
        );
        return {
          status: 202,
          body: await tx.put('exports', {
            id: id('exp'),
            created_at: now(),
            status: 'preparing',
            fingerprint,
            artifacts: artifacts.map((a) => ({
              id: a.id,
              sha256: a.sha256,
              object_version: a.object_version,
              name: a.name,
            })),
            expires_at: secondsFromNow(86400),
            name: 'grt-results.zip',
            error: null,
          }),
        };
      },
      { required: true },
    );
  });
  r.get('/exports/:id', async (req, res) => {
    const e = await db.get('exports', String(req.params.id));
    assert(e, 404, 'not_found', 'Export not found');
    assert(
      Date.parse(e.expires_at) > Date.now(),
      410,
      'export_expired',
      'Export expired; create a new export',
    );
    res.json({
      ...e,
      ...(e.status === 'ready'
        ? { download: await storage.downloadUrl(e, req.auth.expires_at) }
        : {}),
    });
  });
  return r;
}
export function transferRoutes(db: Database, storage: Storage) {
  const r = Router();
  r.get('/transfers/:id', async (req, res, next) => {
    assert(storage.config.STORAGE_DRIVER === 'local', 404, 'not_found', 'Use S3 download URLs');
    const q = z
      .object({
        purpose: z.literal('download'),
        expires: z.string(),
        signature: z.string(),
      })
      .strict()
      .parse(req.query);
    storage.verify(String(req.params.id), q.purpose, q.expires, q.signature);
    const a =
      (await db.get('artifacts', String(req.params.id))) ||
      (await db.get('exports', String(req.params.id)));
    assert(a, 404, 'not_found', 'File not found');
    assert(req.method === 'GET', 405, 'method_not_allowed', 'Use GET');
    assert(['verified', 'ready'].includes(a.status), 409, 'not_verified', 'File is not verified');
    if (a.expires_at)
      assert(Date.parse(a.expires_at) > Date.now(), 410, 'export_expired', 'Export expired');
    res.download(storage.localPath(a.id), a.name, (e) => {
      if (e) next(e);
    });
  });
  return r;
}

// Registered before express.json(): artifact bodies are bounded file streams.
export function uploadRoutes(db: Database, c: Config, storage: Storage) {
  const r = Router();
  r.put('/artifacts/uploads/:id/content', authentication(db, c), writeOnly, async (req, res) => {
    const a = await db.get('artifacts', String(req.params.id));
    assert(a, 404, 'not_found', 'Upload not found');
    const canPublish = async () => {
      if (Date.parse(req.auth.expires_at) <= Date.now()) return false;
      if (req.auth.session_id && !(await db.get('sessions', req.auth.session_id))) return false;
      if (req.auth.token_id) {
        const token = await db.get('tokens', req.auth.token_id);
        if (!token || token.revoked_at || Date.parse(token.expires_at) <= Date.now()) return false;
      }
      const current = await db.get('artifacts', a.id);
      if (current?.status !== 'reserved') return false;
      if (a.kind === 'dataset') return true;
      const job = await db.get('jobs', a.job_id);
      const attempt = await db.get('attempts', a.attempt_id);
      return (
        job?.status === 'running' &&
        job.active_attempt_id === a.attempt_id &&
        attempt?.status === 'running'
      );
    };
    assert(await canPublish(), 409, 'upload_closed', 'Upload is no longer open');
    assert(
      a.size_bytes <= c.MAX_ARTIFACT_BYTES,
      413,
      'file_too_large',
      'Upload exceeds size limit',
    );
    if (req.headers['content-length'])
      assert(
        Number(req.headers['content-length']) === a.size_bytes,
        422,
        'size_mismatch',
        'Content-Length differs from reservation',
      );
    await storage.receive(a.id, req, a.size_bytes, a.sha256, canPublish);
    res.status(204).end();
  });
  return r;
}
