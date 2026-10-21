import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db/index.js';
import { audit, writeOnly } from '../auth.js';
import { mutation } from '../idempotency.js';
import { ApiError, assert, canonical, hash, id, now, page, parse } from '../util.js';
import { finishInput, heartbeatInput, jobInput, name, object, workerInput } from '../validation.js';
import {
  ajv,
  assign,
  attemptView,
  compatibility,
  compileSchema,
  createJob,
  ownership,
  validateJob,
} from '../services/experiments.js';

export function experimentRoutes(db: Database, c: Config) {
  const r = Router();
  r.get('/capabilities', (_req, res) =>
    res.json({
      api_version: 'v1',
      server_version: '0.1.0',
      token_kinds: ['write', 'read-only'],
      limits: {
        json_bytes: c.MAX_JSON_BYTES,
        summary_bytes: c.MAX_JSON_BYTES,
        artifact_bytes: c.MAX_ARTIFACT_BYTES,
        export_bytes: c.MAX_EXPORT_BYTES,
        batch_jobs: 50,
      },
      heartbeat_seconds: c.HEARTBEAT_SECONDS,
      lease_seconds: c.LEASE_SECONDS,
      storage: c.STORAGE_DRIVER,
      runners: ['generic/1'],
      schema_dialect: 'draft-07',
      features: {
        vast_offer_search: !!c.VAST_API_KEY,
        paid_allocations: false,
        notebook_helper: false,
        automatic_retention: false,
        grt_scientific_validation: false,
        training_resume: false,
      },
    }),
  );
  r.get('/schemas', async (req, res) => page(req, res, await db.list('schemas')));
  r.get('/schemas/:id', async (req, res) => {
    const row = await db.get('schemas', String(req.params.id));
    assert(row, 404, 'not_found', 'Schema not found');
    res.json(row);
  });
  r.post('/schemas', writeOnly, async (req, res) => {
    const input = parse(
      z
        .object({
          id: name.regex(/^[\w/-]+$/),
          runner: name,
          name,
          json_schema: object,
          report_schema: object,
          extensions: object.default({}),
        })
        .strict(),
      req.body,
    );
    compileSchema(input.json_schema);
    compileSchema(input.report_schema);
    await mutation(
      db,
      req,
      res,
      async (tx) => {
        assert(
          !(await tx.get('schemas', input.id)),
          409,
          'immutable_schema',
          'Schema ID already exists; register a new version',
        );
        const schema = await tx.put('schemas', {
          ...input,
          created_at: now(),
          content_sha256: hash(canonical(input)),
        });
        await audit(tx, req, 'schema.register', { schema_id: schema.id });
        return { status: 201, body: schema };
      },
      { required: true },
    );
  });
  r.get('/queues', async (req, res) => {
    const jobs = await db.list('jobs');
    page(
      req,
      res,
      (await db.list('queues')).map((q) => ({
        ...q,
        counts: Object.fromEntries(
          [
            'queued',
            'running',
            'finalizing',
            'succeeded',
            'failed',
            'interrupted',
            'cancelled',
          ].map((s) => [s, jobs.filter((j) => j.queue === q.name && j.status === s).length]),
        ),
      })),
    );
  });
  r.post('/queues', writeOnly, async (req, res) => {
    const input = parse(z.object({ name }).strict(), req.body);
    await mutation(
      db,
      req,
      res,
      async (tx) => {
        assert(
          !(await tx.list('queues')).some((q) => q.name === input.name),
          409,
          'queue_exists',
          'Queue name already exists',
        );
        return {
          status: 201,
          body: await tx.put('queues', {
            ...input,
            id: id('queue'),
            created_at: now(),
            paused: false,
          }),
        };
      },
      { required: true },
    );
  });
  r.post('/queues/:id/actions', writeOnly, async (req, res) => {
    const input = parse(z.object({ action: z.enum(['pause', 'resume']) }).strict(), req.body);
    await mutation(db, req, res, async (tx) => {
      const q = await tx.get('queues', String(req.params.id));
      assert(q, 404, 'not_found', 'Queue not found');
      await audit(tx, req, `queue.${input.action}`, { queue_id: q.id });
      return { body: await tx.put('queues', { ...q, paused: input.action === 'pause' }) };
    });
  });
  r.post('/jobs/validate', async (req, res) => {
    const result = await db.write((tx) => validateJob(tx, req.body));
    const workers = await db.list('workers');
    res.json({
      valid: true,
      resolved: result.input,
      compatible_workers: workers
        .filter(
          (w) =>
            !w.draining &&
            !compatibility(
              {
                ...result.input,
                id: '',
                created_at: '',
                upload_margin_seconds: result.settings.upload_margin_seconds,
              },
              w,
            ),
        )
        .map((w) => w.id),
      warnings: [
        'generic/1 validates structure and completion evidence; GRT scientific validation and checkpoint restore require a runner adapter.',
      ],
    });
  });
  r.get('/jobs', async (req, res) => {
    const filters = parse(
      z
        .object({
          queue: z.string().optional(),
          status: z.string().optional(),
          campaign: z.string().optional(),
        })
        .passthrough(),
      req.query,
    );
    const jobs = (await db.list('jobs')).filter(
      (j) =>
        (!filters.queue || j.queue === filters.queue) &&
        (!filters.status || j.status === filters.status) &&
        (!filters.campaign || j.labels.campaign === filters.campaign),
    );
    page(req, res, jobs);
  });
  r.post('/jobs', writeOnly, async (req, res) =>
    mutation(
      db,
      req,
      res,
      async (tx) => ({ status: 201, body: await createJob(tx, req.body, c, req.auth.expires_at) }),
      { required: true },
    ),
  );
  r.post('/jobs/batch', writeOnly, async (req, res) => {
    const input = parse(z.object({ jobs: z.array(jobInput).min(1).max(50) }).strict(), req.body);
    assert(
      input.jobs.every((j) => j.dispatch === 'queued'),
      422,
      'queued_only',
      'Batch accepts queued jobs only',
    );
    await mutation(
      db,
      req,
      res,
      async (tx) => {
        const data = [];
        for (const j of input.jobs) data.push(await createJob(tx, j, c, req.auth.expires_at));
        return { status: 201, body: { data } };
      },
      { required: true },
    );
  });
  r.get('/jobs/:id', async (req, res) => {
    const job = await db.get('jobs', String(req.params.id));
    assert(job, 404, 'not_found', 'Job not found');
    res.json({
      ...job,
      attempts: (await db.list('attempts')).filter((a) => a.job_id === job.id).map(attemptView),
      artifacts: (await db.list('artifacts')).filter((a) => a.job_id === job.id),
    });
  });
  r.patch('/jobs/:id', writeOnly, async (req, res) => {
    const input = parse(
      z
        .object({
          queue: name.optional(),
          priority: z.number().int().min(-10000).max(10000).optional(),
        })
        .strict()
        .refine((v) => Object.keys(v).length > 0),
      req.body,
    );
    await mutation(db, req, res, async (tx) => {
      const job = await tx.get('jobs', String(req.params.id));
      assert(job, 404, 'not_found', 'Job not found');
      assert(
        job.status === 'queued',
        409,
        'job_not_queued',
        'Only queued jobs may move or change priority',
      );
      if (input.queue)
        assert(
          (await tx.list('queues')).some((q) => q.name === input.queue),
          422,
          'queue_not_found',
          'Queue not found',
        );
      return { body: await tx.put('jobs', { ...job, ...input }) };
    });
  });
  r.post('/jobs/:id/actions', writeOnly, async (req, res) => {
    const input = parse(
      z
        .object({
          action: z.enum(['cancel', 'retry', 'clone']),
          termination_evidence: z.string().min(10).max(4000).optional(),
          overrides: object.optional(),
        })
        .strict(),
      req.body,
    );
    await mutation(
      db,
      req,
      res,
      async (tx) => {
        const job = await tx.get('jobs', String(req.params.id));
        assert(job, 404, 'not_found', 'Job not found');
        if (input.action === 'clone') {
          const body = Object.fromEntries(
            Object.keys(jobInput.shape)
              .filter((k) => k !== 'worker_id')
              .map((k) => [k, job[k]]),
          );
          return {
            status: 201,
            body: await createJob(
              tx,
              { ...body, name: `${job.name} (copy)`, dispatch: 'queued', ...input.overrides },
              c,
              req.auth.expires_at,
            ),
          };
        }
        if (input.action === 'cancel') {
          assert(
            ['queued', 'running'].includes(job.status),
            409,
            'invalid_state',
            'Job cannot be cancelled in this state',
          );
          const updated = await tx.put('jobs', {
            ...job,
            cancel_requested: true,
            status: job.status === 'queued' ? 'cancelled' : 'running',
          });
          await audit(tx, req, 'job.cancel', { job_id: job.id });
          return { body: updated };
        }
        assert(
          ['failed', 'interrupted', 'cancelled', 'running'].includes(job.status),
          409,
          'invalid_state',
          'Job cannot be retried in this state',
        );
        if (job.status === 'running') {
          const a = await tx.get('attempts', job.active_attempt_id);
          assert(
            a && Date.parse(a.lease_expires_at) <= Date.now(),
            409,
            'still_running',
            'Active lease must expire before recovery',
          );
          assert(
            input.termination_evidence,
            422,
            'termination_evidence_required',
            'Record evidence that the previous process stopped',
          );
          await tx.put('attempts', {
            ...a,
            status: 'interrupted',
            termination_evidence: input.termination_evidence,
          });
          const worker = await tx.get('workers', a.worker_id);
          if (worker) await tx.put('workers', { ...worker, active_attempt_id: null });
        }
        await audit(tx, req, 'job.retry', {
          job_id: job.id,
          termination_evidence: input.termination_evidence || 'previous finish confirmed',
        });
        return {
          body: await tx.put('jobs', {
            ...job,
            dispatch: 'queued',
            worker_id: undefined,
            status: 'queued',
            cancel_requested: false,
            active_attempt_id: null,
            validation_error: null,
          }),
        };
      },
      { required: true },
    );
  });
  r.get('/workers', async (req, res) => page(req, res, await db.list('workers')));
  r.get('/workers/:id', async (req, res) => {
    const w = await db.get('workers', String(req.params.id));
    assert(w, 404, 'not_found', 'Worker not found');
    const a = w.active_attempt_id ? await db.get('attempts', w.active_attempt_id) : undefined;
    res.json({ ...w, active_attempt: a ? attemptView(a) : null });
  });
  r.post('/workers', writeOnly, async (req, res) => {
    const input = parse(workerInput, req.body);
    assert(
      Date.parse(input.deadline_at) > Date.now(),
      422,
      'invalid_deadline',
      'Worker deadline must be in the future',
    );
    await mutation(
      db,
      req,
      res,
      async (tx) => {
        const previous = (await tx.list('workers')).find(
          (w) => w.session_key === input.session_key,
        );
        if (input.id)
          assert(
            previous?.id === input.id,
            409,
            'worker_identity',
            'Worker ID/session key mismatch',
          );
        if (previous) {
          // Reconnect never hands a replacement process the lease secret.
          const updated = await tx.put('workers', {
            ...previous,
            ...(previous.active_attempt_id ? {} : input),
            id: previous.id,
            last_seen_at: now(),
          });
          const attempt = previous.active_attempt_id
            ? await tx.get('attempts', previous.active_attempt_id)
            : undefined;
          return { body: { ...updated, active_attempt: attempt ? attemptView(attempt) : null } };
        }
        assert(
          input.environment !== 'vast',
          501,
          'provider_disabled',
          'Vast enrollment requires the independent deadline watchdog',
        );
        return {
          status: 201,
          body: await tx.put('workers', {
            ...input,
            id: id('worker'),
            created_at: now(),
            draining: false,
            active_attempt_id: null,
            last_seen_at: now(),
          }),
        };
      },
      { required: true },
    );
  });
  r.post('/workers/:id/actions', writeOnly, async (req, res) => {
    const input = parse(z.object({ action: z.enum(['drain', 'resume']) }).strict(), req.body);
    await mutation(db, req, res, async (tx) => {
      const w = await tx.get('workers', String(req.params.id));
      assert(w, 404, 'not_found', 'Worker not found');
      return { body: await tx.put('workers', { ...w, draining: input.action === 'drain' }) };
    });
  });
  r.post('/workers/:id/claim', writeOnly, async (req, res) => {
    const input = parse(z.object({ queue: name }).strict(), req.body);
    await mutation(
      db,
      req,
      res,
      async (tx) => {
        const worker = await tx.get('workers', String(req.params.id));
        assert(worker, 404, 'not_found', 'Worker not found');
        assert(
          !worker.active_attempt_id,
          409,
          'worker_busy',
          'Reconnect to the existing attempt before claiming',
        );
        await tx.put('workers', { ...worker, last_seen_at: now() });
        const queue = (await tx.list('queues')).find((q) => q.name === input.queue);
        assert(queue, 404, 'not_found', 'Queue not found');
        if (queue.paused || worker.draining)
          return { status: 204, headers: { 'Retry-After': '10' } };
        const jobs = (await tx.list('jobs'))
          .filter(
            (j) => j.status === 'queued' && j.dispatch === 'queued' && j.queue === input.queue,
          )
          .sort(
            (a, b) =>
              b.priority - a.priority ||
              a.created_at.localeCompare(b.created_at) ||
              a.id.localeCompare(b.id),
          );
        for (const job of jobs) {
          if (compatibility(job, worker)) continue;
          const requiredTime =
            (job.policy.eta_seconds ?? job.policy.preflight_seconds) + job.upload_margin_seconds;
          if (Date.parse(req.auth.expires_at) < Date.now() + requiredTime * 1000) continue;
          if (
            job.spec.dataset_artifact_id &&
            (await tx.get('artifacts', job.spec.dataset_artifact_id))?.status !== 'verified'
          )
            continue;
          return { body: await assign(tx, job, worker, c) };
        }
        return { status: 204, headers: { 'Retry-After': '10' } };
      },
      { required: true },
    );
  });
  r.post('/attempts/:id/heartbeat', writeOnly, async (req, res) => {
    const input = parse(heartbeatInput, req.body);
    await mutation(db, req, res, async (tx) => {
      const { attempt, job } = await ownership(tx, String(req.params.id), input);
      if (input.last_verified_checkpoint_id) {
        const a = await tx.get('artifacts', input.last_verified_checkpoint_id);
        assert(
          a &&
            a.job_id === job.id &&
            a.attempt_id === attempt.id &&
            a.kind === 'checkpoint' &&
            a.status === 'verified',
          422,
          'checkpoint_unverified',
          'Checkpoint must be verified for this attempt',
        );
      }
      const { lease_token, worker_id, generation, ...progress } = input;
      const lease_expires_at = new Date(
        Math.min(Date.now() + c.LEASE_SECONDS * 1000, Date.parse(attempt.deadline_at)),
      ).toISOString();
      await tx.put('attempts', {
        ...attempt,
        ...progress,
        last_heartbeat_at: now(),
        lease_expires_at,
      });
      await tx.put('jobs', { ...job, summary: input.summary ?? job.summary });
      const w = await tx.get('workers', worker_id);
      if (w) await tx.put('workers', { ...w, last_seen_at: now() });
      return {
        body: {
          server_time: now(),
          lease_expires_at,
          command:
            job.cancel_requested || Date.parse(attempt.deadline_at) <= Date.now()
              ? 'cancel'
              : w?.draining
                ? 'drain'
                : 'continue',
        },
      };
    });
  });
  r.post('/attempts/:id/finish', writeOnly, async (req, res) => {
    const input = parse(finishInput, req.body);
    await mutation(
      db,
      req,
      res,
      async (tx) => {
        const { attempt, job } = await ownership(tx, String(req.params.id), input);
        assert(
          input.manifest.spec_sha256 === job.spec_sha256,
          422,
          'spec_mismatch',
          'Manifest spec hash mismatch',
        );
        for (const aid of input.artifact_ids) {
          const art = await tx.get('artifacts', aid);
          assert(
            art && art.job_id === job.id && art.attempt_id === attempt.id,
            422,
            'artifact_mismatch',
            'Artifact does not belong to this attempt',
          );
        }
        const { lease_token, ...finish } = input;
        await tx.put('attempts', {
          ...attempt,
          status: 'finalizing',
          stage: input.stage,
          finish,
          finish_received_at: now(),
        });
        await tx.put('jobs', { ...job, status: 'finalizing' });
        return {
          status: 202,
          body: { job_id: job.id, attempt_id: attempt.id, status: 'finalizing' },
        };
      },
      { required: true },
    );
  });
  return r;
}
