import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { Config } from '../config.js';
import type { RecordData, Store } from '../db/index.js';
import { ApiError, assert, canonical, hash, id, now, secret } from '../util.js';
import { jobInput } from '../validation.js';

const Ajv = AjvModule as unknown as typeof AjvModule.default;
const addFormats = addFormatsModule as unknown as typeof addFormatsModule.default;
const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });
addFormats(ajv);
export function compileSchema(schema: any) {
  try {
    return ajv.compile<any>(schema);
  } catch {
    assert(false, 422, 'invalid_schema', 'Invalid JSON Schema (draft-07, strict mode)');
  }
}
export function posthocApplies(job: any): boolean {
  return (
    job.schema_id !== 'grt_wikitext_v1' || !['neox', 'rmt'].includes(job.spec.config?.model?.name)
  );
}
export async function validateJob(tx: Store, raw: any) {
  const input = jobInput.parse(raw);
  assert(
    input.runner === 'generic/1',
    422,
    'unsupported_runner',
    'This release supports generic/1; register a server adapter before using another runner',
  );
  assert(
    Number.isInteger(input.spec.target_steps) && Number(input.spec.target_steps) > 0,
    422,
    'target_required',
    'generic/1 requires a positive integer spec.target_steps',
  );
  const schema = await tx.get('schemas', input.schema_id);
  assert(schema, 422, 'schema_not_found', 'Register the immutable schema first');
  assert(schema.runner === input.runner, 422, 'runner_mismatch', 'Schema runner does not match');
  const queue = (await tx.list('queues')).find((q) => q.name === input.queue);
  assert(queue, 422, 'queue_not_found', 'Create the queue first');
  const spec = structuredClone(input.spec);
  const validate = compileSchema(schema.json_schema);
  if (!validate(spec))
    throw new ApiError(
      422,
      'schema_validation',
      'Spec does not match schema',
      validate.errors?.map((e) => ({ path: e.instancePath, message: e.message })) || [],
    );
  input.policy.require_posthoc = input.policy.require_posthoc && posthocApplies({ ...input, spec });
  // Field-level schema errors are preserved by the validate endpoint/HTTP handler.
  const settings = await tx.get('settings', 'settings');
  input.spec = spec;
  input.policy.max_attempt_seconds ??= settings!.max_attempt_seconds;
  if (input.dispatch === 'attached')
    assert(input.worker_id, 422, 'worker_required', 'Attached jobs require worker_id');
  else assert(!input.worker_id, 422, 'invalid_worker', 'Queued jobs cannot specify worker_id');
  const datasetId = spec.dataset_artifact_id;
  if (datasetId) {
    const dataset = await tx.get('artifacts', String(datasetId));
    assert(
      dataset?.status === 'verified' && dataset.kind === 'dataset',
      422,
      'dataset_unverified',
      'Dataset artifact must be verified',
    );
  }
  return { input, settings: settings! };
}
export async function createJob(tx: Store, raw: any, c: Config, credentialExpiresAt?: string) {
  const { input, settings } = await validateJob(tx, raw);
  const job = await tx.put('jobs', {
    ...input,
    id: id('job'),
    created_at: now(),
    status: 'queued',
    generation: 0,
    spec_sha256: hash(canonical(input.spec)),
    summary: {},
    cancel_requested: false,
    active_attempt_id: null,
    upload_margin_seconds: settings.upload_margin_seconds,
    validation_error: null,
  });
  if (job.dispatch === 'attached') {
    const worker = await tx.get('workers', job.worker_id!);
    assert(worker, 422, 'worker_not_found', 'Worker not found');
    assert(
      !worker.active_attempt_id && !worker.draining,
      409,
      'worker_busy',
      'Worker busy or draining',
    );
    const reason = compatibility(job, worker);
    assert(!reason, 422, 'incompatible_worker', reason || 'Incompatible worker');
    if (credentialExpiresAt)
      assert(
        Date.parse(credentialExpiresAt) >=
          Date.now() +
            ((job.policy.eta_seconds ?? job.policy.preflight_seconds) + job.upload_margin_seconds) *
              1000,
        422,
        'credential_expiring',
        'Token expires too soon to start this attached job',
      );
    const assignment = await assign(tx, job, worker, c);
    return { ...assignment.job, assignment };
  }
  return job;
}
export function compatibility(job: RecordData, worker: RecordData) {
  if (!worker.runners.includes(job.runner)) return 'runner';
  if (!worker.schema_ids.includes(job.schema_id)) return 'schema';
  if (worker.gpu_count < job.requirements.gpu_count) return 'gpu_count';
  if (!job.requirements.labels.every((l: string) => worker.labels.includes(l))) return 'labels';
  const remaining = Math.min(
    (Date.parse(worker.deadline_at) - Date.now()) / 1000,
    job.policy.max_attempt_seconds,
  );
  const eta = job.policy.eta_seconds;
  if (eta === null && !job.policy.checkpointable) return 'unknown ETA requires checkpointable=true';
  const needed = (eta ?? job.policy.preflight_seconds) + job.upload_margin_seconds;
  if (remaining < needed) return 'deadline';
  return null;
}
export async function assign(tx: Store, job: RecordData, worker: RecordData, c: Config) {
  const raw = secret();
  const deadline_at = new Date(
    Math.min(Date.parse(worker.deadline_at), Date.now() + job.policy.max_attempt_seconds * 1000),
  ).toISOString();
  const attempt = await tx.put('attempts', {
    id: id('att'),
    created_at: now(),
    job_id: job.id,
    worker_id: worker.id,
    generation: job.generation + 1,
    status: 'running',
    stage: 'preparing',
    lease_hash: hash(raw),
    lease_expires_at: new Date(
      Math.min(Date.now() + c.LEASE_SECONDS * 1000, Date.parse(deadline_at)),
    ).toISOString(),
    deadline_at,
    last_heartbeat_at: now(),
    progress: null,
    eta_seconds: null,
    metrics: {},
    summary: {},
    last_verified_checkpoint_id: null,
    finish: null,
    resume_artifact_id: job.resume_artifact_id ?? null,
  });
  const updated = await tx.put('jobs', {
    ...job,
    status: 'running',
    generation: attempt.generation,
    active_attempt_id: attempt.id,
    cancel_requested: false,
  });
  await tx.put('workers', { ...worker, active_attempt_id: attempt.id, last_seen_at: now() });
  return {
    job: updated,
    attempt_id: attempt.id,
    lease_token: raw,
    generation: attempt.generation,
    lease_expires_at: attempt.lease_expires_at,
    deadline_at,
    resume_artifact_ids: job.resume_artifact_id ? [job.resume_artifact_id] : [],
    resume_mode: job.resume_artifact_id ? 'checkpoint' : 'fresh',
    heartbeat_seconds: c.HEARTBEAT_SECONDS,
  };
}
export async function ownership(tx: Store, attemptId: string, input: any) {
  const a = await tx.get('attempts', attemptId);
  assert(a, 404, 'not_found', 'Attempt not found');
  const job = await tx.get('jobs', a.job_id);
  assert(
    job &&
      job.active_attempt_id === a.id &&
      job.generation === input.generation &&
      a.generation === input.generation,
    409,
    'stale_generation',
    'This generation no longer owns the job',
  );
  assert(
    a.worker_id === input.worker_id && hash(input.lease_token) === a.lease_hash,
    409,
    'invalid_lease',
    'Worker or lease does not own this attempt',
  );
  assert(a.status === 'running', 409, 'attempt_closed', 'Attempt no longer accepts worker updates');
  assert(
    Date.parse(a.lease_expires_at) > Date.now() && Date.parse(a.deadline_at) > Date.now(),
    409,
    'lease_expired',
    'Worker lease expired; start a new attempt',
  );
  return { attempt: a, job };
}
export function attemptView(a: RecordData) {
  const { lease_hash, ...safe } = a;
  return {
    ...safe,
    stale: a.status === 'running' && Date.parse(a.lease_expires_at) <= Date.now(),
  };
}
