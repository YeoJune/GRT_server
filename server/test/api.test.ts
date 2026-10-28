import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import dotenv from 'dotenv';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { mintToken, setupAccount } from '../src/auth.js';
import { hash, secondsFromNow } from '../src/util.js';

let directory: string;
let db: ReturnType<typeof createDatabase>;
let system: ReturnType<typeof createApp>;
let write: string;
let read: string;
let cookies: string[];
let csrf: string;
let queue: any;
const origin = 'http://localhost:5173';
const schema = {
  id: 'schema_test',
  name: 'Test',
  runner: 'generic/1',
  json_schema: {
    type: 'object',
    required: ['target_steps', 'seed'],
    properties: {
      target_steps: { type: 'integer', minimum: 1 },
      seed: { type: 'integer', default: 42 },
    },
    additionalProperties: false,
  },
  report_schema: {
    type: 'object',
    required: ['completed_steps'],
    properties: { completed_steps: { type: 'integer' } },
    additionalProperties: true,
  },
};
const jobBody = (name = 'test', extra: any = {}) => ({
  name,
  queue: 'research',
  runner: 'generic/1',
  schema_id: schema.id,
  spec: { target_steps: 100 },
  policy: { checkpointable: true },
  extensions: { future_field: { preserved: true } },
  ...extra,
});
function call(
  method: 'get' | 'post' | 'patch' | 'delete' | 'put',
  route: string,
  body?: any,
  token = write,
  key = crypto.randomUUID(),
) {
  const r = request(system.app)[method](`/v1${route}`).set('Authorization', `Bearer ${token}`);
  if (method !== 'get') r.set('Idempotency-Key', key);
  return body === undefined ? r : r.send(body);
}
async function newWorker(extra: any = {}) {
  const r = await call('post', '/workers', {
    name: 'worker',
    session_key: crypto.randomUUID(),
    runners: ['generic/1'],
    schema_ids: [schema.id],
    gpu_count: 1,
    deadline_at: secondsFromNow(7200),
    ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}
async function attached(name = 'attached') {
  const worker = await newWorker();
  const r = await call(
    'post',
    '/jobs',
    jobBody(name, { dispatch: 'attached', worker_id: worker.id }),
  );
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'running');
  const job = await db.get('jobs', r.body.id);
  return { worker, job: job!, assignment: r.body.assignment };
}
function lease(a: any, w: any) {
  return { worker_id: w.id, lease_token: a.lease_token, generation: a.generation };
}
async function upload(
  kind: string,
  bytes: Buffer,
  job?: any,
  attempt?: string,
  expectedHash?: string,
  extensions: Record<string, unknown> = {},
) {
  const reserve = await call('post', '/artifacts/uploads', {
    name: `${kind}.json`,
    kind,
    format: 'json',
    format_version: '1',
    size_bytes: bytes.length,
    sha256: expectedHash || hash(bytes),
    extensions,
    ...(job ? { job_id: job.id, attempt_id: attempt } : {}),
  });
  assert.equal(reserve.status, 201, JSON.stringify(reserve.body));
  const url = new URL(reserve.body.upload.url);
  const put = await request(system.app)
    .put(url.pathname + url.search)
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);
  assert.equal(put.status, 204, JSON.stringify(put.body));
  const complete = await call('post', `/artifacts/uploads/${reserve.body.id}/complete`, {});
  assert.equal(complete.status, 202);
  return reserve.body;
}
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'grt-api-test-'));
  const config = loadConfig({
    ...dotenv.parse(await readFile(new URL('../../.env.example', import.meta.url))),
    NODE_ENV: 'test',
    SQLITE_FILENAME: path.join(directory, 'db.sqlite'),
    STORAGE_DIRECTORY: path.join(directory, 'files'),
    STORAGE_SIGNING_KEY: 'test-key-'.repeat(8),
    APP_ORIGIN: origin,
  });
  db = createDatabase(config);
  await db.migrate();
  await setupAccount(db, 'owner', 'a-very-long-test-password');
  ({ raw: write } = await db.write((tx) =>
    mintToken(tx, { name: 'write-test', kind: 'write', expires_at: secondsFromNow(86400) }),
  ));
  ({ raw: read } = await db.write((tx) =>
    mintToken(tx, { name: 'read-test', kind: 'read-only', expires_at: secondsFromNow(86400) }),
  ));
  system = createApp(db, config);
  const q = await call('post', '/queues', { name: 'research' });
  assert.equal(q.status, 201);
  queue = q.body;
  assert.equal((await call('post', '/schemas', schema)).status, 201);
});
after(async () => {
  await system.background.stop();
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test('health, authentication and cookie CSRF', async () => {
  assert.equal((await request(system.app).get('/healthz')).status, 200);
  assert.equal((await request(system.app).get('/v1/jobs')).status, 401);
  assert.equal((await call('get', '/me', undefined, read)).body.kind, 'read-only');
  const login = await request(system.app)
    .post('/v1/sessions')
    .set('Origin', origin)
    .send({ username: 'owner', password: 'a-very-long-test-password' });
  assert.equal(login.status, 201);
  cookies = login.headers['set-cookie'] as unknown as string[];
  csrf = login.body.csrf_token;
  assert.match(cookies[0], /HttpOnly/);
  assert.match(cookies[0], /SameSite=Strict/);
  assert.equal((await request(system.app).get('/v1/me').set('Cookie', cookies)).status, 200);
  assert.equal(
    (
      await request(system.app)
        .post('/v1/queues')
        .set('Cookie', cookies)
        .send({ name: 'csrf-blocked' })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(system.app)
        .post('/v1/queues')
        .set('Cookie', cookies)
        .set('Origin', origin)
        .set('X-CSRF-Token', csrf)
        .set('Idempotency-Key', crypto.randomUUID())
        .send({ name: 'browser-queue' })
    ).status,
    201,
  );
  assert.equal(
    (
      await request(system.app)
        .post('/v1/sessions')
        .set('Origin', 'https://evil.example')
        .send({ token: write })
    ).status,
    403,
  );
});

test('storage usage requires authentication and permits read-only inspection', async () => {
  assert.equal((await call('get', '/usage/downloads', undefined, read)).status, 404);
  assert.equal((await request(system.app).get('/v1/storage/usage')).status, 401);
  const response = await call('get', '/storage/usage', undefined, read);
  assert.equal(response.status, 200);
  assert.equal(response.body.driver, 'local');
  assert.deepEqual(response.body.s3, { status: 'disabled' });
  assert.ok(response.body.disk.filesystems.length > 0);
  assert.ok(response.body.disk.filesystems.every((d: any) => d.total_bytes > 0));
});

test('queue deletion preserves experiment history, blocks active jobs, and supports retry in another queue', async () => {
  const createKey = crypto.randomUUID();
  const original = await call('post', '/queues', { name: 'finished-queue' }, write, createKey);
  const target = original.body;
  const job = (await call('post', '/jobs', jobBody('queue history', { queue: target.name }))).body;
  assert.equal((await call('delete', `/queues/${target.id}`, undefined, read)).status, 403);
  assert.equal((await call('delete', `/queues/${target.id}`)).body.code, 'queue_busy');
  for (const status of ['running', 'finalizing']) {
    await db.write(async (tx) => {
      await tx.put('jobs', { ...(await tx.get('jobs', job.id))!, status });
    });
    assert.equal((await call('delete', `/queues/${target.id}`)).body.code, 'queue_busy');
  }
  await db.write(async (tx) => {
    await tx.put('jobs', { ...(await tx.get('jobs', job.id))!, status: 'failed' });
  });
  const before = await db.get('jobs', job.id);
  const key = crypto.randomUUID();
  assert.equal((await call('delete', `/queues/${target.id}`, undefined, write, key)).status, 204);
  assert.equal((await call('delete', `/queues/${target.id}`, undefined, write, key)).status, 204);
  assert.ok(!(await call('get', '/queues')).body.data.some((q: any) => q.id === target.id));
  assert.deepEqual(await db.get('jobs', job.id), before);
  assert.equal(
    (await call('post', '/queues', { name: target.name }, write, createKey)).body.code,
    'resource_deleted',
  );
  assert.equal(
    (await call('post', `/jobs/${job.id}/actions`, { action: 'retry' })).body.code,
    'queue_not_found',
  );
  assert.deepEqual(await db.get('jobs', job.id), before);
  const retried = await call('post', `/jobs/${job.id}/actions`, {
    action: 'retry',
    queue: 'research',
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.queue, 'research');
  assert.equal(retried.body.spec_sha256, job.spec_sha256);
  await call('post', `/jobs/${job.id}/actions`, { action: 'cancel' });
  const recreated = await call('post', '/queues', { name: target.name });
  assert.equal(recreated.status, 201);
  assert.notEqual(recreated.body.id, target.id);
  await call('delete', `/queues/${recreated.body.id}`);
  const racing = (await call('post', '/queues', { name: 'racing-queue' })).body;
  const [removed, submitted] = await Promise.all([
    call('delete', `/queues/${racing.id}`),
    call('post', '/jobs', jobBody('racing submit', { queue: racing.name })),
  ]);
  assert.ok(
    (removed.status === 204 && submitted.status === 422) ||
      (removed.status === 409 && submitted.status === 201),
  );
  if (submitted.status === 201) {
    await call('post', `/jobs/${submitted.body.id}/actions`, { action: 'cancel' });
    await call('delete', `/queues/${racing.id}`);
  }
});

test('read-only cannot write even through POST actions, but can validate', async () => {
  for (const route of [
    '/tokens',
    '/jobs',
    '/jobs/batch',
    '/workers',
    '/schemas',
    '/allocations',
    `/queues/${queue.id}/actions`,
  ]) {
    assert.equal((await call('post', route, {}, read)).status, 403, route);
  }
  assert.equal((await call('patch', '/settings', { upload_margin_seconds: 60 }, read)).status, 403);
  assert.equal((await call('post', '/jobs/validate', jobBody(), read)).status, 200);
});

test('settings affect new jobs and reject unsupported retention options', async () => {
  const original = (await call('get', '/settings')).body;
  assert.equal(original.checkpoint_retention_days, undefined);
  assert.equal(original.result_retention_days, undefined);
  const before = await call('post', '/jobs', jobBody('before policy change'));
  assert.equal(before.status, 201);
  try {
    const update = await call('patch', '/settings', {
      max_attempt_seconds: 7200,
      upload_margin_seconds: 60,
    });
    assert.equal(update.status, 200);
    const after = await call('post', '/jobs', jobBody('after policy change'));
    assert.equal(after.status, 201);
    assert.equal(after.body.policy.max_attempt_seconds, 7200);
    assert.equal(after.body.upload_margin_seconds, 60);
    const unchanged = (await call('get', `/jobs/${before.body.id}`)).body;
    assert.equal(unchanged.policy.max_attempt_seconds, original.max_attempt_seconds);
    assert.equal(unchanged.upload_margin_seconds, original.upload_margin_seconds);
    for (const field of ['checkpoint_retention_days', 'result_retention_days']) {
      const rejected = await call('patch', '/settings', { [field]: 30 });
      assert.equal(rejected.status, 422);
    }
    assert.equal((await call('patch', '/settings', {})).status, 422);
  } finally {
    const restored = await call('patch', '/settings', {
      max_attempt_seconds: original.max_attempt_seconds,
      upload_margin_seconds: original.upload_margin_seconds,
    });
    assert.equal(restored.status, 200);
    for (const job of (await db.list('jobs')).filter((j) => j.name.endsWith('policy change')))
      await call('post', `/jobs/${job.id}/actions`, { action: 'cancel' });
  }
});

test('schema validation returns field errors, preserves defaults and rejects core typos', async () => {
  const valid = await call('post', '/jobs/validate', jobBody());
  assert.equal(valid.status, 200);
  assert.equal(valid.body.resolved.spec.seed, 42);
  const invalid = await call(
    'post',
    '/jobs',
    jobBody('invalid', { spec: { target_steps: 100, unknown_parameter: 1 } }),
  );
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.code, 'schema_validation');
  assert.ok(invalid.body.field_errors.length);
  assert.equal((await call('post', '/jobs', { ...jobBody(), priorty: 1 })).status, 422);
  assert.equal((await call('post', '/schemas', schema)).status, 409);
  assert.equal(
    (await call('post', '/jobs', jobBody('unsupported', { runner: 'grt/1' }))).status,
    422,
  );
});

test('omitted and empty policy/requirements resolve the same nested defaults', async () => {
  const input = jobBody('nested defaults');
  delete input.policy;
  const omitted = await call('post', '/jobs/validate', input);
  const empty = await call('post', '/jobs/validate', { ...input, policy: {}, requirements: {} });
  assert.equal(omitted.status, 200, JSON.stringify(omitted.body));
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.deepEqual(omitted.body.resolved, empty.body.resolved);
  assert.deepEqual(omitted.body.resolved.requirements, { gpu_count: 0, labels: [] });
  assert.deepEqual(omitted.body.resolved.policy, {
    max_attempt_seconds: (await db.get('settings', 'settings'))!.max_attempt_seconds,
    eta_seconds: null,
    checkpointable: false,
    preflight_seconds: 60,
    required_artifact_kinds: ['report', 'config', 'provenance'],
    require_posthoc: false,
  });
  assert.equal(
    (await call('post', '/jobs/validate', { ...input, policy: { require_posthoc: 'yes' } })).status,
    422,
  );
});

test('idempotency survives token replacement, conflicts on changed body, and requires a key', async () => {
  const key = crypto.randomUUID();
  const input = jobBody('idempotent');
  const first = await call('post', '/jobs', input, write, key);
  assert.equal(first.status, 201);
  const replacement = await db.write((tx) =>
    mintToken(tx, { name: 'replacement', kind: 'write', expires_at: secondsFromNow(86400) }),
  );
  const second = await call('post', '/jobs', input, replacement.raw, key);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.headers['idempotency-replayed'], 'true');
  assert.equal((await call('post', '/jobs', jobBody('changed'), write, key)).status, 409);
  assert.equal(
    (await request(system.app).post('/v1/jobs').set('Authorization', `Bearer ${write}`).send(input))
      .status,
    422,
  );
  const record = await call('get', `/requests/${key}`, undefined, read);
  assert.equal(record.status, 200);
  assert.equal(record.body.reply.body.id, first.body.id);
});

test('batch is all-or-nothing and extensions survive storage', async () => {
  const before = (await db.list('jobs')).length;
  const bad = await call('post', '/jobs/batch', {
    jobs: [jobBody('batch-good'), jobBody('batch-bad', { schema_id: 'missing' })],
  });
  assert.equal(bad.status, 422);
  assert.equal((await db.list('jobs')).length, before);
  const good = await call('post', '/jobs/batch', {
    jobs: [jobBody('batch-one'), jobBody('batch-two')],
  });
  assert.equal(good.status, 201);
  assert.deepEqual(good.body.data[0].extensions, { future_field: { preserved: true } });
});

test('paused queues and draining workers do not claim; priority and concurrent claim are atomic', async () => {
  const w1 = await newWorker();
  const w2 = await newWorker();
  await call('post', `/queues/${queue.id}/actions`, { action: 'pause' });
  assert.equal((await call('post', `/workers/${w1.id}/claim`, { queue: 'research' })).status, 204);
  await call('post', `/queues/${queue.id}/actions`, { action: 'resume' });
  await call('post', `/workers/${w1.id}/actions`, { action: 'drain' });
  assert.equal((await call('post', `/workers/${w1.id}/claim`, { queue: 'research' })).status, 204);
  await call('post', `/workers/${w1.id}/actions`, { action: 'resume' });
  const high = await call('post', '/jobs', jobBody('highest', { priority: 9999 }));
  const claims = await Promise.all([
    call('post', `/workers/${w1.id}/claim`, { queue: 'research' }),
    call('post', `/workers/${w2.id}/claim`, { queue: 'research' }),
  ]);
  assert.ok(claims.every((r) => r.status === 200));
  assert.notEqual(claims[0].body.job.id, claims[1].body.job.id);
  assert.ok(claims.some((r) => r.body.job.id === high.body.id));
  assert.equal((await call('post', `/workers/${w1.id}/claim`, { queue: 'research' })).status, 409);
});

test('incompatible workers and expiring tokens do not receive jobs', async () => {
  const w = await newWorker({ runners: ['unsupported/1'] });
  assert.equal((await call('post', `/workers/${w.id}/claim`, { queue: 'research' })).status, 204);
  const capable = await newWorker();
  const soon = await db.write((tx) =>
    mintToken(tx, { name: 'expires-soon', kind: 'write', expires_at: secondsFromNow(60) }),
  );
  assert.equal(
    (await call('post', `/workers/${capable.id}/claim`, { queue: 'research' }, soon.raw)).status,
    204,
  );
});

test('attached jobs never enter the queue; reconnect does not reveal lease; immutable specs', async () => {
  const { worker, job, assignment } = await attached();
  assert.equal(job.status, 'running');
  assert.ok(assignment.lease_token);
  const record = await call('get', `/jobs/${job.id}`);
  assert.equal(record.body.attempts.length, 1);
  assert.equal(record.body.attempts[0].lease_hash, undefined);
  assert.equal((await call('patch', `/jobs/${job.id}`, { priority: 9 })).status, 409);
  assert.equal(
    (await call('patch', `/jobs/${job.id}`, { spec: { target_steps: 200 } })).status,
    422,
  );
  const reconnect = await call('post', '/workers', { ...workerInputFor(worker), id: worker.id });
  assert.equal(reconnect.status, 200);
  assert.equal(reconnect.body.active_attempt.id, assignment.attempt_id);
  assert.equal(reconnect.body.active_attempt.lease_token, undefined);
  assert.equal(reconnect.body.active_attempt.lease_hash, undefined);
});
function workerInputFor(w: any) {
  return Object.fromEntries(
    ['name', 'session_key', 'runners', 'schema_ids', 'gpu_count', 'deadline_at'].map((k) => [
      k,
      w[k],
    ]),
  );
}

test('lease owner can reconnect after expiry; stale retry requires termination evidence and fences old generation', async () => {
  const { worker, job, assignment } = await attached('stale');
  const heartbeat = {
    ...lease(assignment, worker),
    stage: 'training',
    progress: { current: 5, total: null, unit: 'step' },
  };
  assert.equal(
    (
      await call('post', `/attempts/${assignment.attempt_id}/heartbeat`, {
        ...heartbeat,
        lease_token: 'x'.repeat(40),
      })
    ).status,
    409,
  );
  await db.write(async (tx) => {
    const a = (await tx.get('attempts', assignment.attempt_id))!;
    await tx.put('attempts', { ...a, lease_expires_at: secondsFromNow(-1) });
  });
  assert.equal(
    (await call('post', `/attempts/${assignment.attempt_id}/heartbeat`, heartbeat)).status,
    200,
  );
  await db.write(async (tx) => {
    const a = (await tx.get('attempts', assignment.attempt_id))!;
    await tx.put('attempts', { ...a, lease_expires_at: secondsFromNow(-1) });
  });
  assert.equal((await call('post', `/jobs/${job.id}/actions`, { action: 'retry' })).status, 422);
  const retry = await call('post', `/jobs/${job.id}/actions`, {
    action: 'retry',
    termination_evidence: 'Notebook runtime was deleted; verified by owner.',
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.status, 'queued');
  assert.equal(
    (await call('post', `/attempts/${assignment.attempt_id}/heartbeat`, heartbeat)).status,
    409,
  );
  assert.ok(
    (await db.list('audit')).some((a) => a.action === 'job.retry' && a.termination_evidence),
  );
});

test('cancellation sends a command and never pretends a disconnected worker stopped', async () => {
  const { worker, job, assignment } = await attached('cancel');
  const r = await call('post', `/jobs/${job.id}/actions`, { action: 'cancel' });
  assert.equal(r.body.status, 'running');
  assert.equal(r.body.cancel_requested, true);
  const hb = await call('post', `/attempts/${assignment.attempt_id}/heartbeat`, {
    ...lease(assignment, worker),
    stage: 'training',
  });
  assert.equal(hb.body.command, 'cancel');
});

test('file transfer verifies SHA256, immutable bytes, and read-only downloads', async () => {
  const bytes = Buffer.from('dataset test bytes');
  const a = await upload('dataset', bytes);
  await system.background.tick();
  assert.equal((await db.get('artifacts', a.id))!.status, 'verified');
  const dl = await call('get', `/artifacts/${a.id}/download`, undefined, read);
  assert.equal(dl.status, 200);
  const u = new URL(dl.body.url);
  const get = await request(system.app).get(u.pathname + u.search);
  assert.equal(get.status, 200);
  assert.deepEqual(get.body, bytes);
  assert.equal(
    (
      await request(system.app).get(
        u.pathname + u.search.replace(/signature=[a-f0-9]+/, 'signature=invalid'),
      )
    ).status,
    401,
  );
  const malformed = new URL(dl.body.url);
  malformed.searchParams.set('signature', '가'.repeat(64));
  assert.equal((await request(system.app).get(malformed.pathname + malformed.search)).status, 401);
  const failed = await upload('dataset', bytes, undefined, undefined, '0'.repeat(64));
  await system.background.tick();
  assert.equal((await db.get('artifacts', failed.id))!.status, 'failed');
  const url = new URL(a.upload.url);
  assert.equal(
    (
      await request(system.app)
        .put(url.pathname + url.search)
        .send(bytes)
    ).status,
    409,
  );
});

test('completed finish is durable, verifies evidence and cannot be overwritten by heartbeat', async () => {
  const { worker, job, assignment } = await attached('complete');
  const configBytes = Buffer.from(JSON.stringify({ seed: 42, target_steps: 100 }));
  const configHash = hash(configBytes);
  const evidence = { spec_sha256: job.spec_sha256, config_sha256: configHash };
  const config = await upload('config', configBytes, job, assignment.attempt_id);
  const report = await upload(
    'report',
    Buffer.from(JSON.stringify({ ...evidence, completed_steps: 100 })),
    job,
    assignment.attempt_id,
  );
  const provenance = await upload(
    'provenance',
    Buffer.from(JSON.stringify({ ...evidence, runner: 'generic/1' })),
    job,
    assignment.attempt_id,
  );
  const finish = {
    ...lease(assignment, worker),
    outcome: 'completed',
    stage: 'uploading',
    artifact_ids: [config.id, report.id, provenance.id],
    manifest: { ...evidence, completed_steps: 100, target_steps: 100, posthoc_completed: false },
  };
  const finishingToken = await db.write((tx) =>
    mintToken(tx, { name: 'finishing-worker', kind: 'write', expires_at: secondsFromNow(7200) }),
  );
  const key = crypto.randomUUID();
  assert.equal(
    (
      await call(
        'post',
        `/attempts/${assignment.attempt_id}/finish`,
        finish,
        finishingToken.raw,
        key,
      )
    ).status,
    202,
  );
  await call('delete', `/tokens/${finishingToken.token.id}`);
  assert.equal((await call('get', '/me', undefined, finishingToken.raw)).status, 401);
  assert.equal((await db.get('jobs', job.id))!.status, 'finalizing');
  assert.equal(
    (
      await call('post', `/attempts/${assignment.attempt_id}/heartbeat`, {
        ...lease(assignment, worker),
        stage: 'uploading',
      })
    ).status,
    409,
  );
  await system.background.tick();
  const done = await db.get('jobs', job.id);
  assert.equal(done!.status, 'succeeded', JSON.stringify(done));
  assert.equal((await db.get('workers', worker.id))!.active_attempt_id, null);
  assert.equal(
    (await call('post', `/attempts/${assignment.attempt_id}/finish`, finish, write, key)).status,
    202,
  );
  const exp = await call('post', '/exports', { job_ids: [job.id] }, read);
  assert.equal(exp.status, 202);
  await system.background.tick();
  const expGet = await call('get', `/exports/${exp.body.id}`, undefined, read);
  assert.equal(expGet.body.status, 'ready');
  assert.ok(expGet.body.download.url);
  const zipUrl = new URL(expGet.body.download.url);
  const zip = await request(system.app).get(zipUrl.pathname + zipUrl.search);
  assert.equal(zip.status, 200);
  assert.equal(zip.body.subarray(0, 2).toString(), 'PK');
});

test('finish cannot claim success without verified config/provenance/report', async () => {
  const { worker, job, assignment } = await attached('no-evidence');
  const r = await call('post', `/attempts/${assignment.attempt_id}/finish`, {
    ...lease(assignment, worker),
    outcome: 'completed',
    stage: 'uploading',
    artifact_ids: [],
    manifest: {
      spec_sha256: job.spec_sha256,
      config_sha256: '0'.repeat(64),
      completed_steps: 100,
      target_steps: 100,
      posthoc_completed: false,
    },
  });
  assert.equal(r.status, 202);
  await system.background.tick();
  const failed = (await db.get('jobs', job.id))!;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.validation_error.code, 'missing_artifact');
});

test('token secret shown once, metadata redacted, revoked token session immediately rejected', async () => {
  const key = crypto.randomUUID();
  const r = await call(
    'post',
    '/tokens',
    { name: 'browser-reader', kind: 'read-only', expires_at: secondsFromNow(3600) },
    write,
    key,
  );
  assert.equal(r.status, 201);
  assert.ok(r.body.token);
  assert.equal(r.body.secret_hash, undefined);
  assert.equal(
    (
      await call(
        'post',
        '/tokens',
        { name: 'browser-reader', kind: 'read-only', expires_at: r.body.expires_at },
        write,
        key,
      )
    ).status,
    409,
  );
  const recovered = await call('get', `/requests/${key}`);
  assert.equal(recovered.body.reply.body.token, undefined);
  const login = await request(system.app).post('/v1/sessions').send({ token: r.body.token });
  assert.equal(login.status, 201);
  const tokenCookie = login.headers['set-cookie'] as unknown as string[];
  assert.equal((await request(system.app).get('/v1/me').set('Cookie', tokenCookie)).status, 200);
  assert.equal((await call('delete', `/tokens/${r.body.id}`)).status, 204);
  assert.equal((await request(system.app).get('/v1/me').set('Cookie', tokenCookie)).status, 401);
  assert.equal((await call('get', '/me', undefined, r.body.token)).status, 401);
  assert.equal(
    (await call('patch', `/tokens/${r.body.id}`, { expires_at: secondsFromNow(7200) })).status,
    409,
  );
});

test('expired bearer credentials return 401 and pagination is cursor based', async () => {
  const t = await db.write((tx) =>
    mintToken(tx, { name: 'expired', kind: 'read-only', expires_at: secondsFromNow(100) }),
  );
  await db.write((tx) => tx.put('tokens', { ...t.token, expires_at: secondsFromNow(-1) }));
  assert.equal((await call('get', '/jobs', undefined, t.raw)).status, 401);
  const first = await call('get', '/jobs?limit=2', undefined, read);
  assert.equal(first.body.data.length, 2);
  assert.ok(first.body.next_cursor);
  const second = await call(
    'get',
    `/jobs?limit=2&cursor=${first.body.next_cursor}`,
    undefined,
    read,
  );
  assert.equal(second.body.data.length, 2);
  assert.ok(first.body.data.every((a: any) => !second.body.data.some((b: any) => a.id === b.id)));
  assert.equal((await call('get', '/jobs?limit=1000')).status, 422);
});

test('password recovery revokes sessions and production rejects insecure config', async () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', STORAGE_SIGNING_KEY: 'x'.repeat(40) }),
    /HTTPS/,
  );
  await setupAccount(db, 'owner', 'new-long-test-password', true);
  assert.equal((await request(system.app).get('/v1/me').set('Cookie', cookies)).status, 401);
  assert.equal((await call('get', '/me')).status, 200); // token revocation is opt-in
  assert.equal((await db.get('schemas', schema.id))!.runner, 'generic/1');
  assert.equal((await call('post', '/allocations', {})).status, 501);
});

test('SQLite records and accepted work survive closing and reopening the connection', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    SQLITE_FILENAME: path.join(directory, 'restart.sqlite'),
    STORAGE_DIRECTORY: path.join(directory, 'restart-files'),
    STORAGE_SIGNING_KEY: 'restart-key-'.repeat(8),
  });
  const first = createDatabase(config);
  await first.migrate();
  await first.write((tx) =>
    tx.put('jobs', {
      id: 'job_restart',
      created_at: new Date().toISOString(),
      status: 'finalizing',
      active_attempt_id: 'att_restart',
      generation: 1,
      cancel_requested: false,
    }),
  );
  await first.write((tx) =>
    tx.put('attempts', {
      id: 'att_restart',
      created_at: new Date().toISOString(),
      status: 'finalizing',
      job_id: 'job_restart',
      worker_id: 'worker_restart',
      generation: 1,
      finish: { outcome: 'interrupted', error: null },
    }),
  );
  await first.close();
  const second = createDatabase(config);
  await second.migrate();
  const restarted = createApp(second, config);
  await restarted.background.tick();
  assert.equal((await second.get('jobs', 'job_restart'))!.status, 'interrupted');
  assert.equal((await second.get('attempts', 'att_restart'))!.status, 'interrupted');
  await restarted.background.stop();
  await second.close();
});

test('claim replay records job IDs and requires the original lease; attached checks credential lifetime', async () => {
  const worker = await newWorker();
  const key = crypto.randomUUID();
  const first = await call(
    'post',
    `/workers/${worker.id}/claim`,
    { queue: 'research' },
    write,
    key,
  );
  assert.equal(first.status, 200);
  assert.ok(first.body.lease_token);
  const replay = await call(
    'post',
    `/workers/${worker.id}/claim`,
    { queue: 'research' },
    write,
    key,
  );
  assert.equal(replay.body.attempt_id, first.body.attempt_id);
  assert.equal(replay.body.lease_token, undefined);
  assert.equal(replay.body.lease_recovery_required, true);
  const w2 = await newWorker();
  const soon = await db.write((tx) =>
    mintToken(tx, { name: 'short-attached', kind: 'write', expires_at: secondsFromNow(60) }),
  );
  const short = await call(
    'post',
    '/jobs',
    jobBody('too-soon', { dispatch: 'attached', worker_id: w2.id }),
    soon.raw,
  );
  assert.equal(short.status, 422);
  assert.equal(short.body.code, 'credential_expiring');
  assert.equal((await db.get('workers', w2.id))!.active_attempt_id, null);
});

test('CLI authenticates and incrementally streams verified results without exposing credentials', async () => {
  const server = system.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const previousOrigin = system.storage.config.APP_ORIGIN;
  system.storage.config.APP_ORIGIN = base;
  const cli = async (...args: string[]) =>
    promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', path.resolve('../scripts/grt.ts'), ...args],
      {
        env: { ...process.env, GRT_SERVER_URL: base, GRT_SERVER_TOKEN: read },
        cwd: process.cwd(),
      },
    );
  try {
    const me = await cli('me', '--json');
    assert.equal(JSON.parse(me.stdout).kind, 'read-only');
    assert.ok(!me.stdout.includes(read));
    const output = path.join(directory, 'collected');
    const first = await cli('results', 'collect', '--new', '--output', output);
    assert.equal(JSON.parse(first.stdout).downloaded, 3);
    const second = await cli('results', 'collect', '--new', '--output', output);
    assert.equal(JSON.parse(second.stdout).downloaded, 0);
    const managed = (await call('post', '/jobs', jobBody('cli-management'))).body;
    const changes = path.join(directory, 'metadata.json');
    await writeFile(changes, JSON.stringify({ name: 'CLI renamed', campaign: 'cli' }));
    const writeCli = (...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', path.resolve('../scripts/grt.ts'), ...args],
        {
          env: { ...process.env, GRT_SERVER_URL: base, GRT_SERVER_TOKEN: write },
          cwd: process.cwd(),
        },
      );
    const updated = await writeCli('jobs', 'update', managed.id, '--file', changes);
    assert.equal(JSON.parse(updated.stdout).name, 'CLI renamed');
    await assert.rejects(writeCli('jobs', 'delete', managed.id), /Use jobs delete ID --yes/);
    assert.equal((await db.get('jobs', managed.id))!.status, 'queued');
    const deletion = await writeCli('jobs', 'delete', managed.id, '--yes');
    assert.equal(JSON.parse(deletion.stdout).deletion_requested, true);
    await system.background.tick();
    assert.equal(await db.get('jobs', managed.id), undefined);
  } finally {
    system.storage.config.APP_ORIGIN = previousOrigin;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test('experiment metadata can change without changing its immutable spec; active deletion is blocked', async () => {
  const created = await call(
    'post',
    '/jobs',
    jobBody('manage', { labels: { campaign: 'old', preserved: 'yes' } }),
  );
  const job = created.body;
  const updated = await call('patch', `/jobs/${job.id}`, {
    name: 'renamed',
    campaign: 'new',
    priority: 5,
    wandb_url: 'https://wandb.ai/grt/research/runs/example',
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'renamed');
  assert.equal(updated.body.summary.wandb_url, 'https://wandb.ai/grt/research/runs/example');
  assert.equal((await call('patch', `/jobs/${job.id}`, { wandb_url: 'invalid-url' })).status, 422);
  assert.equal(
    (await call('patch', `/jobs/${job.id}`, { wandb_url: 'javascript:alert(1)' })).status,
    422,
  );
  assert.equal(updated.body.labels.campaign, 'new');
  assert.equal(updated.body.labels.preserved, 'yes');
  assert.deepEqual(updated.body.spec, job.spec);
  assert.equal(updated.body.spec_sha256, job.spec_sha256);
  const cleared = await call('patch', `/jobs/${job.id}`, { campaign: null });
  assert.equal(cleared.body.labels.campaign, undefined);
  assert.equal((await call('patch', `/jobs/${job.id}`, { spec: { target_steps: 1 } })).status, 422);
  assert.equal((await call('patch', `/jobs/${job.id}`, { name: 'reader' }, read)).status, 403);
  assert.equal((await call('delete', `/jobs/${job.id}`, undefined, read)).status, 403);
  const active = await attached('active-management');
  assert.equal(
    (await call('patch', `/jobs/${active.job.id}`, { name: 'active renamed' })).status,
    200,
  );
  assert.equal((await call('patch', `/jobs/${active.job.id}`, { priority: 1 })).status, 409);
  assert.equal((await call('delete', `/jobs/${active.job.id}`)).body.code, 'job_active');
});

test('permanent deletion removes output bytes and ZIPs, survives cleanup failure, and fences cached replies', async (t) => {
  const { job, assignment, worker } = await attached('delete-results');
  const createdRequest = (await db.list('requests')).find((r) => r.reply?.body?.id === job.id)!;
  const file = await upload('result', Buffer.from('private output'), job, assignment.attempt_id);
  const dataset = await upload('dataset', Buffer.from('shared input'));
  await system.background.tick();
  const finished = await call('post', `/attempts/${assignment.attempt_id}/finish`, {
    ...lease(assignment, worker),
    outcome: 'cancelled',
    stage: 'uploading',
    error: null,
    artifact_ids: [file.id],
    manifest: {
      spec_sha256: job.spec_sha256,
      config_sha256: hash('unused'),
      completed_steps: 0,
      target_steps: 100,
      posthoc_completed: false,
    },
  });
  assert.equal(finished.status, 202);
  await system.background.tick();
  const exportReply = await call('post', '/exports', {
    job_ids: [job.id],
    artifact_ids: [dataset.id],
  });
  assert.equal((await call('delete', `/jobs/${job.id}`)).body.code, 'export_busy');
  await system.background.tick();
  const exported = (await call('get', `/exports/${exportReply.body.id}`)).body;
  assert.equal(exported.status, 'ready');
  const originalLink = (await call('get', `/artifacts/${file.id}/download`)).body.url;
  const deleteKey = crypto.randomUUID();
  assert.equal((await call('delete', `/jobs/${job.id}`, undefined, write, deleteKey)).status, 202);
  assert.equal((await call('get', `/artifacts/${file.id}/download`)).status, 404);
  const u = new URL(originalLink);
  assert.notEqual((await request(system.app).get(u.pathname + u.search)).status, 200);
  assert.equal((await call('get', `/exports/${exported.id}`)).body.download, undefined);
  assert.equal((await call('patch', `/jobs/${job.id}`, { name: 'resurrect' })).status, 409);
  assert.equal((await call('post', `/jobs/${job.id}/actions`, { action: 'retry' })).status, 409);

  system.storage.receiving.set(file.id, 1);
  await system.background.tick();
  assert.ok(await db.get('jobs', job.id));
  system.storage.receiving.delete(file.id);
  const failure = t.mock.method(system.storage, 'remove', async () => {
    throw new Error('private storage failure');
  });
  await system.background.tick();
  assert.equal((await db.get('jobs', job.id))!.deletion_error.code, 'storage_error');
  failure.mock.restore();
  await call('delete', `/jobs/${job.id}`); // explicit retry clears the backoff
  const { Background } = await import('../src/services/background.js');
  await new Background(db, system.storage).tick(); // recover persisted deletion in a fresh processor
  assert.equal((await call('get', `/jobs/${job.id}`)).status, 404);
  assert.equal((await call('get', `/artifacts/${file.id}/download`)).status, 404);
  assert.equal((await call('get', `/exports/${exported.id}`)).status, 404);
  await assert.rejects(readFile(system.storage.localPath(file.id)), { code: 'ENOENT' });
  await assert.rejects(readFile(system.storage.localPath(exported.id)), { code: 'ENOENT' });
  assert.equal(
    (await db.list('attempts')).some((a) => a.job_id === job.id),
    false,
  );
  assert.equal((await call('get', `/artifacts/${dataset.id}/download`)).status, 200);
  assert.equal((await db.get('requests', createdRequest.id))!.state, 'deleted');
  assert.equal((await db.get('requests', createdRequest.id))!.reply, null);
  assert.equal((await call('post', '/jobs', {}, write, createdRequest.id)).status, 410);
  assert.equal((await call('delete', `/jobs/${job.id}`, undefined, write, deleteKey)).status, 202);
  assert.equal((await call('delete', `/jobs/${job.id}`)).status, 204);
  assert.ok((await db.list('audit')).some((a) => a.action === 'job.delete' && a.job_id === job.id));
});

test('resume requires a verified snapshot and termination; fresh retry clears the source; snapshots rotate safely', async () => {
  const { job, assignment, worker } = await attached('resume-control');
  assert.equal(
    (await call('post', `/jobs/${job.id}/actions`, { action: 'resume' })).body.code,
    'still_running',
  );
  await db.write(async (tx) => {
    const a = (await tx.get('attempts', assignment.attempt_id))!;
    await tx.put('attempts', { ...a, lease_expires_at: secondsFromNow(-10) });
  });
  assert.equal(
    (await call('post', `/jobs/${job.id}/actions`, { action: 'resume' })).body.code,
    'termination_evidence_required',
  );
  const evidence = 'Verified that the previous runtime is terminated';
  assert.equal(
    (
      await call('post', `/jobs/${job.id}/actions`, {
        action: 'resume',
        termination_evidence: evidence,
      })
    ).body.code,
    'resume_checkpoint_missing',
  );
  assert.equal((await db.get('attempts', assignment.attempt_id))!.status, 'running'); // rollback
  const source = await upload(
    'checkpoint',
    Buffer.from('resume snapshot'),
    job,
    assignment.attempt_id,
    undefined,
    { resume_format: 'grt.resume/1', step: 1 },
  );
  await system.background.tick();
  assert.equal(
    (await call('post', `/jobs/${job.id}/actions`, { action: 'resume' }, read)).status,
    403,
  );
  const queued = await call('post', `/jobs/${job.id}/actions`, {
    action: 'resume',
    termination_evidence: evidence,
  });
  assert.equal(queued.body.resume_artifact_id, source.id);
  await call('patch', `/jobs/${job.id}`, { priority: 10000 });
  const next = await call('post', `/workers/${worker.id}/claim`, { queue: queue.name });
  assert.equal(next.body.resume_mode, 'checkpoint');
  assert.deepEqual(next.body.resume_artifact_ids, [source.id]);
  const renewed = next.body;
  for (const step of [2, 3]) {
    await upload(
      'checkpoint',
      Buffer.from('snapshot-' + step),
      job,
      renewed.attempt_id,
      undefined,
      { resume_format: 'grt.resume/1', step },
    );
    await system.background.tick();
  }
  assert.equal((await db.get('artifacts', source.id))!.status, 'verified'); // source pinned by running resume
  const complete = await call('post', `/attempts/${renewed.attempt_id}/finish`, {
    ...lease(renewed, worker),
    outcome: 'interrupted',
    stage: 'training',
    artifact_ids: [],
    manifest: {
      spec_sha256: job.spec_sha256,
      config_sha256: hash('unused'),
      completed_steps: 3,
      target_steps: 100,
      posthoc_completed: false,
    },
  });
  assert.equal(complete.status, 202);
  await system.background.tick();
  assert.equal((await db.get('artifacts', source.id))!.status, 'purged');
  await assert.rejects(readFile(system.storage.localPath(source.id)), { code: 'ENOENT' });
  const fresh = await call('post', `/jobs/${job.id}/actions`, { action: 'retry' });
  assert.equal(fresh.body.resume_artifact_id, null);
  const freshClaim = await call('post', `/workers/${worker.id}/claim`, { queue: queue.name });
  assert.equal(freshClaim.body.resume_mode, 'fresh');
  assert.deepEqual(freshClaim.body.resume_artifact_ids, []);
});
