import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import { PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/index.js';
import { createApp } from '../src/app.js';
import { mintToken } from '../src/auth.js';
import { hash, secondsFromNow } from '../src/util.js';

test('authenticated EC2 uploads verify raw bytes, use SDK S3 PUT, and preserve immutable retries', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'grt-relay-api-'));
  const config = loadConfig({
    NODE_ENV: 'test',
    STORAGE_DRIVER: 's3',
    S3_BUCKET: 'example-only-bucket',
    SQLITE_FILENAME: path.join(directory, 'db.sqlite'),
    STORAGE_DIRECTORY: path.join(directory, 'staging'),
    STORAGE_SIGNING_KEY: 'test-key-'.repeat(8),
    MAX_JSON_BYTES: '1024',
  });
  const db = createDatabase(config);
  await db.migrate();
  const { app, storage, background } = createApp(db, config);
  const write = await db.write((tx) =>
    mintToken(tx, { name: 'write', kind: 'write', expires_at: secondsFromNow(3600) }),
  );
  const read = await db.write((tx) =>
    mintToken(tx, { name: 'read', kind: 'read-only', expires_at: secondsFromNow(3600) }),
  );
  const objects = new Map<string, Buffer>();
  let puts = 0;
  (storage as any).s3 = {
    send: async (command: any) => {
      const key = command.input.Key;
      if (command instanceof PutObjectCommand) {
        puts++;
        assert.equal(command.input.IfNoneMatch, '*');
        if (objects.has(key)) throw { $metadata: { httpStatusCode: 412 } };
        const chunks: Buffer[] = [];
        for await (const chunk of command.input.Body) chunks.push(chunk);
        objects.set(key, Buffer.concat(chunks));
        return { VersionId: 'version-1' };
      }
      const bytes = objects.get(key)!;
      if (command instanceof HeadObjectCommand)
        return {
          ContentLength: bytes.length,
          ChecksumSHA256: Buffer.from(hash(bytes), 'hex').toString('base64'),
          VersionId: 'version-1',
        };
      assert.ok(command instanceof GetObjectCommand);
      return { Body: Readable.from([bytes]) };
    },
  };
  const bytes = Buffer.alloc(4096, 'x');
  const reserve = async (sha = hash(bytes)) => {
    const response = await request(app)
      .post('/v1/artifacts/uploads')
      .set('Authorization', `Bearer ${write.raw}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        name: 'input.bin',
        kind: 'dataset',
        format: 'binary',
        format_version: '1',
        size_bytes: bytes.length,
        sha256: sha,
      });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const url = new URL(response.body.upload.url);
    assert.equal(url.origin, config.APP_ORIGIN);
    assert.equal(url.search, '');
    return { item: response.body, route: url.pathname };
  };
  try {
    const { item, route } = await reserve();
    assert.equal((await request(app).put(route).send(bytes)).status, 401);
    assert.equal(
      (await request(app).put(route).set('Authorization', `Bearer ${read.raw}`).send(bytes)).status,
      403,
    );
    // Even JSON-named/typed evidence bypasses the small JSON body parser.
    assert.equal(
      (
        await request(app)
          .put(route)
          .set('Authorization', `Bearer ${write.raw}`)
          .set('Content-Type', 'application/json')
          .send(bytes.toString())
      ).status,
      204,
    );
    assert.deepEqual(objects.get(`grt/${item.id}`), bytes);
    assert.deepEqual(await readdir(storage.directory), []);
    assert.equal(
      (await request(app).put(route).set('Authorization', `Bearer ${write.raw}`).send(bytes))
        .status,
      204,
    );
    assert.equal(puts, 2); // second conditional PUT reuses the original version
    const complete = await request(app)
      .post(`/v1/artifacts/uploads/${item.id}/complete`)
      .set('Authorization', `Bearer ${write.raw}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({});
    assert.equal(complete.status, 202);
    await background.tick();
    assert.equal((await db.get('artifacts', item.id))!.status, 'verified');
    assert.equal(
      (await request(app).put(route).set('Authorization', `Bearer ${write.raw}`).send(bytes))
        .status,
      409,
    );
    const invalid = await reserve('0'.repeat(64));
    assert.equal(
      (
        await request(app)
          .put(invalid.route)
          .set('Authorization', `Bearer ${write.raw}`)
          .send(bytes)
      ).status,
      422,
    );
    assert.equal(objects.has(`grt/${invalid.item.id}`), false);
    assert.deepEqual(await readdir(storage.directory), []);
    assert.equal(puts, 2);
  } finally {
    await background.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
