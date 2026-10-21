import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
) {
  const reserve = await call('post', '/artifacts/uploads', {
    name: `${kind}.json`,
    kind,
    format: 'json',
    format_version: '1',
    size_bytes: bytes.length,
    sha256: expectedHash || hash(bytes),
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
  assert.equal((await call('patch', '/settings', { result_retention_days: 30 }, read)).status, 403);
  assert.equal((await call('post', '/jobs/validate', jobBody(), read)).status, 200);
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
  } finally {
    system.storage.config.APP_ORIGIN = previousOrigin;
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
