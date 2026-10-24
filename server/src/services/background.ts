import { createWriteStream } from 'node:fs';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import archiver from 'archiver';
import type { Database, RecordData } from '../db/index.js';
import { ApiError, assert, canonical, now } from '../util.js';
import { compileSchema } from './experiments.js';
import type { Storage } from './storage.js';

export class Background {
  private busy?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private db: Database,
    private storage: Storage,
  ) {}
  start() {
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
    this.timer.unref();
    void this.tick();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.busy;
  }
  async tick() {
    if (this.busy) return this.busy;
    this.busy = this.run()
      .catch((e) => {
        console.error(
          JSON.stringify({
            event: 'background.error',
            code: e instanceof ApiError ? e.code : 'internal_error',
          }),
        );
      })
      .finally(() => {
        this.busy = undefined;
      });
    return this.busy;
  }
  private async run() {
    for (const a of (await this.db.list('artifacts')).filter((a) => a.status === 'verifying'))
      await this.verify(a);
    for (const a of (await this.db.list('attempts')).filter((a) => a.status === 'finalizing'))
      await this.finalize(a);
    for (const e of (await this.db.list('exports')).filter((e) => e.status === 'preparing'))
      await this.export(e);
    await this.retireResumeSnapshots();
    for (const job of (await this.db.list('jobs')).filter((j) => j.status === 'deleting'))
      await this.deleteJob(job);
  }
  private async retireResumeSnapshots() {
    const artifacts = await this.db.list('artifacts');
    const jobs = await this.db.list('jobs');
    const pinned = new Set(
      jobs
        .filter((j) => ['queued', 'running', 'finalizing'].includes(j.status))
        .map((j) => j.resume_artifact_id),
    );
    for (const job of jobs) {
      const snapshots = artifacts
        .filter(
          (a) =>
            a.job_id === job.id &&
            a.status === 'verified' &&
            a.extensions?.resume_format === 'grt.resume/1',
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      for (const old of snapshots.slice(2).filter((a) => !pinned.has(a.id)))
        await this.db.write(async (tx) => {
          const current = await tx.get('artifacts', old.id);
          const owner = await tx.get('jobs', old.job_id);
          if (
            current?.status === 'verified' &&
            !(
              owner?.resume_artifact_id === old.id &&
              ['queued', 'running', 'finalizing'].includes(owner.status)
            )
          )
            await tx.put('artifacts', {
              ...current,
              status: 'retired',
              delete_after: new Date(
                Date.now() +
                  (this.storage.config.STORAGE_DRIVER === 's3'
                    ? this.storage.config.SIGNED_URL_SECONDS * 1000
                    : 0),
              ).toISOString(),
            });
        });
    }
    const exports = await this.db.list('exports');
    for (const old of (await this.db.list('artifacts')).filter((a) => a.status === 'retired')) {
      if (
        Date.parse(old.delete_after) > Date.now() ||
        Date.parse(old.delete_retry_at) > Date.now() ||
        this.storage.receiving.has(old.id) ||
        exports.some(
          (e) => e.status === 'preparing' && e.artifacts.some((a: any) => a.id === old.id),
        )
      )
        continue;
      try {
        await this.storage.remove(old);
        await this.db.write(async (tx) => {
          const current = await tx.get('artifacts', old.id);
          if (current?.status === 'retired')
            await tx.put('artifacts', { ...current, status: 'purged', error: null });
        });
      } catch (error) {
        await this.db.write(async (tx) => {
          const current = await tx.get('artifacts', old.id);
          if (current?.status === 'retired')
            await tx.put('artifacts', {
              ...current,
              error: this.safeError(error),
              delete_retry_at: new Date(Date.now() + 30000).toISOString(),
            });
        });
      }
    }
  }
  private async deleteJob(job: RecordData) {
    if (Date.parse(job.delete_after) > Date.now() || Date.parse(job.delete_retry_at) > Date.now())
      return;
    const artifacts = (await this.db.list('artifacts')).filter((a) => a.job_id === job.id);
    if (artifacts.some((a) => this.storage.receiving.has(a.id))) return;
    const ids = new Set(artifacts.map((a) => a.id));
    const exports = (await this.db.list('exports')).filter((e) =>
      e.artifacts.some((a: any) => ids.has(a.id)),
    );
    try {
      for (const item of [...exports, ...artifacts]) await this.storage.remove(item);
      await this.db.write(async (tx) => {
        const attempts = (await tx.list('attempts')).filter((a) => a.job_id === job.id);
        const removedIds = new Set([
          job.id,
          ...ids,
          ...exports.map((e) => e.id),
          ...attempts.map((a) => a.id),
        ]);
        const references = (value: any): boolean =>
          typeof value === 'string'
            ? removedIds.has(value)
            : !!value && typeof value === 'object' && Object.values(value).some(references);
        // Keep idempotency tombstones, not cached specs/files that could be replayed.
        for (const record of await tx.list('requests'))
          if (!record.reply?.body?.deletion_requested && references(record.reply))
            await tx.put('requests', { ...record, state: 'deleted', reply: null });
        for (const worker of await tx.list('workers'))
          if (removedIds.has(worker.active_attempt_id))
            await tx.put('workers', { ...worker, active_attempt_id: null });
        for (const e of exports) await tx.remove('exports', e.id);
        for (const a of artifacts) await tx.remove('artifacts', a.id);
        for (const a of attempts) await tx.remove('attempts', a.id);
        await tx.remove('jobs', job.id);
      });
    } catch (error) {
      await this.db.write(async (tx) => {
        const current = await tx.get('jobs', job.id);
        if (current?.status === 'deleting')
          await tx.put('jobs', {
            ...current,
            deletion_error: this.safeError(error),
            delete_retry_at: new Date(Date.now() + 30000).toISOString(),
          });
      });
    }
  }
  private safeError(error: any) {
    return error instanceof ApiError
      ? { code: error.code, message: error.message }
      : {
          code: 'storage_error',
          message: 'Storage operation failed; check server storage configuration',
        };
  }
  private async verify(a: RecordData) {
    try {
      const metadata = await this.storage.inspect(a);
      assert(
        metadata.size_bytes === a.size_bytes,
        422,
        'size_mismatch',
        'Stored file size mismatch',
      );
      const digest = await this.storage.digest({ ...a, ...metadata });
      assert(
        digest.sha256 === a.sha256 && digest.size_bytes === a.size_bytes,
        422,
        'sha256_mismatch',
        'Stored file SHA256 mismatch',
      );
      await this.db.write(async (tx) => {
        const current = await tx.get('artifacts', a.id);
        if (current?.status === 'verifying')
          await tx.put('artifacts', {
            ...current,
            ...metadata,
            status: 'verified',
            verified_at: now(),
            error: null,
          });
      });
    } catch (error: any) {
      // Missing objects/storage outages may be temporary. Keep requests durable across restarts.
      const transient = !(error instanceof ApiError);
      if (transient && Date.now() - Date.parse(a.verification_requested_at) < 600000) return;
      await this.db.write(async (tx) => {
        const current = await tx.get('artifacts', a.id);
        if (current?.status === 'verifying')
          await tx.put('artifacts', { ...current, status: 'failed', error: this.safeError(error) });
      });
    }
  }
  private async finalize(a: RecordData) {
    const job = await this.db.get('jobs', a.job_id);
    if (!job || job.active_attempt_id !== a.id || job.generation !== a.generation) return;
    let status: string = a.finish.outcome === 'completed' ? 'succeeded' : a.finish.outcome;
    let validationError: any = null;
    try {
      if (a.finish.outcome === 'completed') {
        const artifacts = await Promise.all(
          a.finish.artifact_ids.map((aid: string) => this.db.get('artifacts', aid)),
        );
        assert(
          artifacts.every((v) => v && v.job_id === job.id && v.attempt_id === a.id),
          422,
          'artifact_mismatch',
          'Finish artifact ownership mismatch',
        );
        assert(
          !artifacts.some((v) => v!.status === 'failed'),
          422,
          'artifact_failed',
          'Required artifact verification failed',
        );
        if (artifacts.some((v) => v!.status !== 'verified')) {
          assert(
            Date.now() - Date.parse(a.finish_received_at) < 86400000,
            422,
            'finalization_timeout',
            'Files were not verified within 24 hours',
          );
          return;
        }
        for (const kind of job.policy.required_artifact_kinds)
          assert(
            artifacts.some((v) => v!.kind === kind),
            422,
            'missing_artifact',
            `Missing required artifact: ${kind}`,
          );
        // These three evidence types are always mandatory for generic/1.
        const report = artifacts.find((v) => v!.kind === 'report');
        const config = artifacts.find((v) => v!.kind === 'config');
        const provenance = artifacts.find((v) => v!.kind === 'provenance');
        assert(
          report && config && provenance,
          422,
          'missing_evidence',
          'Report, config, and provenance artifacts are mandatory',
        );
        assert(
          config.sha256 === a.finish.manifest.config_sha256,
          422,
          'config_mismatch',
          'Config SHA256 does not match manifest',
        );
        const [reportJson, provenanceJson, configJson] = await Promise.all([
          this.storage.json(report),
          this.storage.json(provenance),
          this.storage.json(config),
        ]);
        assert(
          configJson &&
            typeof configJson === 'object' &&
            !Array.isArray(configJson) &&
            Object.entries(job.spec).every(
              ([key, value]) => canonical(configJson[key]) === canonical(value),
            ),
          422,
          'config_spec_mismatch',
          'Actual config must preserve all resolved spec fields',
        );
        const schema = await this.db.get('schemas', job.schema_id);
        const validate = compileSchema(schema!.report_schema);
        assert(
          validate(reportJson),
          422,
          'report_schema',
          'Report failed the registered JSON Schema',
        );
        const m = a.finish.manifest;
        assert(
          m.completed_steps >= m.target_steps && m.target_steps === job.spec.target_steps,
          422,
          'budget_incomplete',
          'Manifest target must match spec.target_steps and be complete',
        );
        assert(
          reportJson.spec_sha256 === job.spec_sha256 &&
            reportJson.config_sha256 === config.sha256 &&
            reportJson.completed_steps >= m.target_steps,
          422,
          'report_mismatch',
          'Report evidence does not match the immutable spec/config/budget',
        );
        assert(
          provenanceJson.spec_sha256 === job.spec_sha256 &&
            provenanceJson.config_sha256 === config.sha256 &&
            provenanceJson.runner === job.runner,
          422,
          'provenance_mismatch',
          'Provenance spec/config/runner mismatch',
        );
        assert(
          !job.policy.require_posthoc ||
            (m.posthoc_completed && reportJson.posthoc_completed === true),
          422,
          'posthoc_incomplete',
          'Required posthoc was not completed',
        );
      }
      if (status === 'succeeded' && job.cancel_requested) status = 'cancelled';
      if (status === 'failed' && a.finish.error)
        validationError = { code: 'worker_failed', message: a.finish.error };
    } catch (error) {
      status = 'failed';
      validationError = this.safeError(error);
    }
    await this.db.write(async (tx) => {
      const current = await tx.get('jobs', job.id);
      const attempt = await tx.get('attempts', a.id);
      if (current?.active_attempt_id !== a.id || attempt?.status !== 'finalizing') return;
      await tx.put('jobs', {
        ...current,
        status,
        validation_error: validationError,
        finished_at: now(),
        active_attempt_id: null,
      });
      await tx.put('attempts', {
        ...attempt,
        status,
        validation_error: validationError,
        finished_at: now(),
      });
      const w = await tx.get('workers', a.worker_id);
      if (w?.active_attempt_id === a.id) await tx.put('workers', { ...w, active_attempt_id: null });
    });
  }
  private async export(e: RecordData) {
    const dir = await mkdtemp(path.join(tmpdir(), 'grt-export-'));
    try {
      // If the process died after persisting the immutable ZIP, adopt it on restart.
      let stored: any;
      try {
        stored = await this.storage.inspect(e);
      } catch {
        /* not yet stored */
      }
      if (!stored) {
        const filename = path.join(dir, 'result.zip');
        const out = createWriteStream(filename, { flags: 'wx', mode: 0o600 });
        const archive = archiver('zip', { zlib: { level: 1 } });
        const completion = finished(out);
        completion.catch(() => {});
        archive.on('error', (error) => out.destroy(error));
        archive.pipe(out);
        try {
          archive.append(JSON.stringify({ artifacts: e.artifacts }, null, 2), {
            name: 'manifest.json',
          });
          for (const selected of e.artifacts) {
            const a = await this.db.get('artifacts', selected.id);
            assert(
              a?.status === 'verified' &&
                a.sha256 === selected.sha256 &&
                a.object_version === selected.object_version,
              409,
              'export_changed',
              'Selected artifact changed',
            );
            archive.append(await this.storage.stream(a), {
              name: `${a.job_id || 'inputs'}/${a.id}/${a.name}`,
            });
          }
          await archive.finalize();
          await completion;
        } catch (err) {
          archive.abort();
          out.destroy();
          throw err;
        }
        const size = (await stat(filename)).size;
        assert(
          size <= this.storage.config.MAX_EXPORT_BYTES + 10485760,
          413,
          'export_too_large',
          'ZIP exceeds export size limit',
        );
        const object_version = await this.storage.storeFile(e.id, filename);
        stored = { object_version, size_bytes: size };
      }
      const digest = await this.storage.digest({ ...e, ...stored });
      await this.db.write((tx) =>
        tx.put('exports', { ...e, ...stored, ...digest, status: 'ready', ready_at: now() }),
      );
    } catch (error) {
      await this.db.write((tx) =>
        tx.put('exports', { ...e, status: 'failed', error: this.safeError(error) }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
