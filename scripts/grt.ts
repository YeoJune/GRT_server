import dotenv from 'dotenv';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const args = process.argv.slice(2);
const jsonFlag = args.indexOf('--json');
if (jsonFlag >= 0) args.splice(jsonFlag, 1);
const [resource, command, subject] = args;
const base = process.env.GRT_SERVER_URL?.replace(/\/$/, '');
const token = process.env.GRT_SERVER_TOKEN;
if (!base || !token) {
  console.error('Set GRT_SERVER_URL and GRT_SERVER_TOKEN in the environment.');
  process.exit(1);
}
// Keep credentials out of command arguments and diagnostic output.
const requestKey = process.env.GRT_REQUEST_ID || crypto.randomUUID();
async function request(
  route: string,
  method = 'GET',
  body?: unknown,
  key = requestKey,
): Promise<any> {
  const response = await fetch(`${base}/v1${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(method !== 'GET' ? { 'Idempotency-Key': key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok)
    throw new Error(
      `${response.status} ${data.code}: ${data.message} (request ${data.request_id})`,
    );
  return data;
}
async function list(route: string) {
  const result = [];
  let cursor: string | null = null;
  do {
    const p = await request(
      `${route}${route.includes('?') ? '&' : '?'}limit=100${cursor ? `&cursor=${cursor}` : ''}`,
    );
    result.push(...p.data);
    cursor = p.next_cursor;
  } while (cursor);
  return result;
}
function option(flag: string) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
async function fileHash(filename: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}
async function collect() {
  const campaign = option('--campaign');
  const dest = path.resolve(option('--output') || './grt-results');
  await mkdir(dest, { recursive: true });
  const jobs = await list(
    `/jobs?status=succeeded${campaign ? `&campaign=${encodeURIComponent(campaign)}` : ''}`,
  );
  let downloaded = 0;
  for (const job of jobs) {
    const detail = await request(`/jobs/${job.id}`);
    for (const artifact of detail.artifacts.filter((a: any) => a.status === 'verified')) {
      const filename = path.join(dest, `${artifact.id}-${artifact.sha256}`);
      if (args.includes('--new')) {
        try {
          if ((await fileHash(filename)) === artifact.sha256) continue;
        } catch {
          /* download below */
        }
      }
      const link = await request(`/artifacts/${artifact.id}/download`);
      const response = await fetch(link.url);
      if (!response.ok) throw new Error('Artifact download failed');
      if (!response.body) throw new Error('Artifact download has no body');
      const temporary = `${filename}.${crypto.randomUUID()}.partial`;
      const digest = createHash('sha256');
      let bytes = 0;
      try {
        await pipeline(
          Readable.fromWeb(response.body as any),
          new Transform({
            transform(chunk, _encoding, callback) {
              bytes += chunk.length;
              digest.update(chunk);
              callback(null, chunk);
            },
          }),
          createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
        );
        if (digest.digest('hex') !== artifact.sha256 || bytes !== artifact.size_bytes)
          throw new Error('Artifact size or SHA256 mismatch');
        await rename(temporary, filename);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      await writeFile(`${filename}.json`, JSON.stringify(artifact, null, 2), { mode: 0o600 });
      downloaded++;
    }
  }
  return { directory: dest, downloaded };
}
try {
  let result: any;
  if (resource === 'me') result = await request('/me');
  else if (resource === 'storage' && command === 'usage') result = await request('/storage/usage');
  else if (resource === 'jobs' && ['submit', 'validate', 'batch'].includes(command)) {
    if (!subject) throw new Error('Provide a JSON file');
    const input = JSON.parse(await readFile(subject, 'utf8'));
    result = await request(
      command === 'submit' ? '/jobs' : `/jobs/${command}`,
      'POST',
      command === 'batch' && Array.isArray(input) ? { jobs: input } : input,
    );
  } else if (resource === 'jobs' && command === 'list')
    result = await list(
      `/jobs${option('--queue') ? `?queue=${encodeURIComponent(option('--queue')!)}` : ''}`,
    );
  else if (resource === 'jobs' && command === 'get')
    result = await request(`/jobs/${encodeURIComponent(subject)}`);
  else if (resource === 'jobs' && command === 'update') {
    const changes = option('--file');
    if (!subject || !changes) throw new Error('Use jobs update ID --file metadata.json');
    result = await request(
      `/jobs/${encodeURIComponent(subject)}`,
      'PATCH',
      JSON.parse(await readFile(changes, 'utf8')),
    );
  } else if (resource === 'jobs' && command === 'delete') {
    if (!subject || !args.includes('--yes'))
      throw new Error(
        'Permanent deletion removes experiment data and result files. Use jobs delete ID --yes',
      );
    result = await request(`/jobs/${encodeURIComponent(subject)}`, 'DELETE');
  } else if (resource === 'jobs' && ['cancel', 'retry', 'resume', 'clone'].includes(command))
    result = await request(`/jobs/${encodeURIComponent(subject)}/actions`, 'POST', {
      action: command,
      ...(option('--checkpoint') ? { checkpoint_artifact_id: option('--checkpoint') } : {}),
      ...(option('--evidence') ? { termination_evidence: option('--evidence') } : {}),
    });
  else if (resource === 'queues' && command === 'create')
    result = await request('/queues', 'POST', { name: subject });
  else if (resource === 'queues' && ['pause', 'resume'].includes(command)) {
    const queue = (await list('/queues')).find((q: any) => q.id === subject || q.name === subject);
    if (!queue) throw new Error('Queue not found');
    result = await request(`/queues/${queue.id}/actions`, 'POST', { action: command });
  } else if (resource === 'workers' && ['drain', 'resume'].includes(command))
    result = await request(`/workers/${encodeURIComponent(subject)}/actions`, 'POST', {
      action: command,
      ...(option('--checkpoint') ? { checkpoint_artifact_id: option('--checkpoint') } : {}),
    });
  else if (resource === 'schemas' && command === 'register')
    result = await request('/schemas', 'POST', JSON.parse(await readFile(subject, 'utf8')));
  else if (resource === 'results' && command === 'collect') result = await collect();
  else if (resource === 'exports' && command === 'create')
    result = await request('/exports', 'POST', {
      job_ids: (option('--jobs') || '').split(',').filter(Boolean),
    });
  else if (resource === 'exports' && command === 'get')
    result = await request(`/exports/${encodeURIComponent(subject)}`);
  else if (resource === 'requests' && command === 'get')
    result = await request(`/requests/${encodeURIComponent(subject)}`);
  else if (resource === 'tokens' && command === 'create') {
    if (!process.stdout.isTTY)
      throw new Error(
        'Token issuance requires an interactive terminal (one-time secret). Use the dedicated UI for browser access.',
      );
    result = await request('/tokens', 'POST', {
      name: option('--name') || 'cli',
      kind: option('--kind') || 'read-only',
      expires_at: option('--expires-at'),
    });
    process.stdout.write(`Token (shown once): ${result.token}\n`);
    delete result.token;
  } else
    throw new Error(
      'Commands: me; storage usage; jobs submit|validate|batch FILE, list [--queue NAME], get|cancel|retry|resume|clone ID, update ID --file metadata.json, delete ID --yes; queues create|pause|resume NAME; workers drain|resume ID; schemas register FILE; results collect [--campaign NAME] [--new] [--output DIR]; exports create --jobs ID,ID; exports get ID; requests get ID; tokens create --kind read-only --expires-at ISO',
    );
  if (result?.csrf_token) delete result.csrf_token;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error: any) {
  console.error(error.message);
  process.exitCode = 1;
}
