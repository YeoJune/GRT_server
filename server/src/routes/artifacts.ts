import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import type { Config } from '../config.js';
import { writeOnly } from '../auth.js';
import { mutation } from '../idempotency.js';
import { assert, canonical, hash, id, now, secondsFromNow } from '../util.js';
import { name } from '../validation.js';
import type { Storage } from '../services/storage.js';

export function artifactRoutes(db: Database, c: Config, storage: Storage) {
  const r = Router();
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
      extensions: z.record(z.unknown()).default({}),
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
      return res.json({ ...a, upload: await storage.url(a, 'upload', req.auth.expires_at) });
    }
    const input = uploadInput.parse(req.body);
    await mutation(
      db,
      req,
      res,
      async (tx) => {
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
          body: { ...a, upload: await storage.url(a, 'upload', req.auth.expires_at) },
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
      ...(await storage.url(a, 'download', req.auth.expires_at)),
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
        for (const jid of input.job_ids)
          assert(await tx.get('jobs', jid), 422, 'job_not_found', 'Selected job not found');
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
        ? { download: await storage.url(e, 'download', req.auth.expires_at) }
        : {}),
    });
  });
  return r;
}
export function transferRoutes(db: Database, storage: Storage) {
  const r = Router();
  r.all('/transfers/:id', async (req, res, next) => {
    assert(storage.config.STORAGE_DRIVER === 'local', 404, 'not_found', 'Use S3 transfer URLs');
    const q = z
      .object({
        purpose: z.enum(['upload', 'download']),
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
    if (q.purpose === 'upload') {
      assert(req.method === 'PUT', 405, 'method_not_allowed', 'Use PUT');
      assert(a.status === 'reserved', 409, 'upload_closed', 'Upload is no longer open');
      if (req.headers['content-length'])
        assert(
          Number(req.headers['content-length']) === a.size_bytes,
          422,
          'size_mismatch',
          'Content-Length differs from declared size',
        );
      await storage.receive(a.id, req, a.size_bytes);
      res.status(204).end();
    } else {
      assert(req.method === 'GET', 405, 'method_not_allowed', 'Use GET');
      assert(['verified', 'ready'].includes(a.status), 409, 'not_verified', 'File is not verified');
      if (a.expires_at)
        assert(Date.parse(a.expires_at) > Date.now(), 410, 'export_expired', 'Export expired');
      res.download(storage.localPath(a.id), a.name, (e) => {
        if (e) next(e);
      });
    }
  });
  return r;
}
