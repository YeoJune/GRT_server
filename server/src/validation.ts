import { z } from 'zod';
export const object = z.record(z.unknown());
export const time = z
  .string()
  .datetime({ offset: true })
  .transform((v) => new Date(v).toISOString());
export const name = z.string().trim().min(1).max(150);
export const kind = z.enum(['write', 'read-only']);
export const jobInput = z
  .object({
    name,
    queue: name.default('research'),
    priority: z.number().int().min(-10000).max(10000).default(0),
    dispatch: z.enum(['queued', 'attached']).default('queued'),
    worker_id: z.string().optional(),
    runner: name,
    schema_id: name,
    spec: object,
    requirements: z
      .object({ gpu_count: z.number().int().min(0).default(0), labels: z.array(name).default([]) })
      .strict()
      .default({}),
    policy: z
      .object({
        max_attempt_seconds: z.number().int().positive().max(604800).optional(),
        eta_seconds: z.number().int().positive().nullable().default(null),
        checkpointable: z.boolean().default(false),
        preflight_seconds: z.number().int().positive().default(60),
        required_artifact_kinds: z
          .array(
            z.enum(['report', 'config', 'provenance', 'checkpoint', 'log', 'result', 'dataset']),
          )
          .default(['report', 'config', 'provenance']),
        require_posthoc: z.boolean().default(false),
      })
      .strict()
      .default({}),
    labels: z.record(z.string()).default({}),
    extensions: object.default({}),
  })
  .strict();
export const workerInput = z
  .object({
    id: z.string().optional(),
    name,
    session_key: z.string().min(8).max(200),
    environment: z.enum(['colab', 'kaggle', 'remote', 'vast']).default('remote'),
    runners: z.array(name).min(1),
    schema_ids: z.array(name).min(1),
    gpu_count: z.number().int().nonnegative().default(0),
    world_size: z.number().int().positive().default(1),
    labels: z.array(name).default([]),
    deadline_at: time,
    extensions: object.default({}),
  })
  .strict();
const leaseInput = z.object({
  worker_id: z.string(),
  lease_token: z.string().min(20),
  generation: z.number().int().positive(),
});
export const heartbeatInput = leaseInput
  .extend({
    stage: z.enum(['preparing', 'preflight', 'training', 'posthoc', 'uploading']),
    progress: z
      .object({
        current: z.number().nonnegative(),
        total: z.number().nonnegative().nullable(),
        unit: name,
      })
      .strict()
      .optional(),
    eta_seconds: z.number().nonnegative().nullable().optional(),
    metrics: object.optional(),
    summary: object.optional(),
    last_verified_checkpoint_id: z.string().nullable().optional(),
  })
  .strict();
export const finishInput = leaseInput
  .extend({
    outcome: z.enum(['completed', 'interrupted', 'failed', 'cancelled']),
    stage: name,
    error: z.string().max(4000).nullable().default(null),
    artifact_ids: z.array(z.string()).max(1000),
    manifest: z
      .object({
        spec_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        completed_steps: z.number().int().nonnegative(),
        target_steps: z.number().int().positive(),
        posthoc_completed: z.boolean(),
        config_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
