import { createHmac, createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '../config.js';
import { resolveRoot } from '../config.js';
import { ApiError, assert, equal, secret } from '../util.js';

export class Storage {
  private s3?: S3Client;
  readonly directory: string;
  constructor(public config: Config) {
    this.directory = resolveRoot(config.STORAGE_DIRECTORY);
    if (config.STORAGE_DRIVER === 's3') this.s3 = new S3Client({ region: config.AWS_REGION });
  }
  private key(id: string) {
    assert(/^[\w-]+$/.test(id), 422, 'invalid_id', 'Invalid artifact ID');
    return `${this.config.S3_PREFIX}${id}`;
  }
  localPath(id: string) {
    assert(/^[\w-]+$/.test(id), 422, 'invalid_id', 'Invalid artifact ID');
    return path.join(this.directory, id);
  }
  private signature(id: string, purpose: string, expires: number) {
    return createHmac('sha256', this.config.STORAGE_SIGNING_KEY)
      .update(`${id}:${purpose}:${expires}`)
      .digest('hex');
  }
  verify(id: string, purpose: string, expires: string, sig: string) {
    const expiry = Number(expires);
    assert(
      Number.isFinite(expiry) &&
        expiry > Date.now() &&
        equal(sig, this.signature(id, purpose, expiry)),
      401,
      'invalid_signature',
      'Transfer URL invalid or expired',
    );
  }
  async url(item: any, purpose: 'upload' | 'download', expiresAt: string) {
    const seconds = Math.min(
      this.config.SIGNED_URL_SECONDS,
      Math.floor((Date.parse(expiresAt) - Date.now()) / 1000),
    );
    assert(seconds > 0, 401, 'expired', 'Credential expires too soon');
    const expiry = Date.now() + seconds * 1000;
    let url: string;
    if (this.s3) {
      const command =
        purpose === 'upload'
          ? new PutObjectCommand({
              Bucket: this.config.S3_BUCKET,
              Key: this.key(item.id),
              ContentLength: item.size_bytes,
              ChecksumSHA256: Buffer.from(item.sha256, 'hex').toString('base64'),
              ServerSideEncryption: 'AES256',
            })
          : new GetObjectCommand({
              Bucket: this.config.S3_BUCKET,
              Key: this.key(item.id),
              VersionId: item.object_version,
              ResponseContentDisposition: `attachment; filename="${encodeURIComponent(item.name)}"`,
            });
      url = await getSignedUrl(this.s3, command, { expiresIn: seconds });
    } else {
      url = `${this.config.APP_ORIGIN}/v1/transfers/${item.id}?purpose=${purpose}&expires=${expiry}&signature=${this.signature(item.id, purpose, expiry)}`;
    }
    return {
      url,
      expires_at: new Date(expiry).toISOString(),
      headers:
        purpose === 'upload' && this.s3
          ? {
              'x-amz-checksum-sha256': Buffer.from(item.sha256, 'hex').toString('base64'),
              'x-amz-server-side-encryption': 'AES256',
            }
          : {},
    };
  }
  async receive(id: string, stream: Readable, expectedSize: number) {
    assert(!this.s3, 404, 'not_found', 'Use the S3 upload URL');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.upload-${secret()}`);
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        if (bytes > expectedSize)
          cb(new ApiError(413, 'file_too_large', 'Upload exceeds declared size'));
        else cb(null, chunk);
      },
    });
    try {
      await pipeline(stream, limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      assert(bytes === expectedSize, 422, 'size_mismatch', 'Upload differs from declared size');
      try {
        await link(temporary, this.localPath(id));
      } catch (e: any) {
        if (e.code === 'EEXIST')
          throw new ApiError(
            409,
            'immutable_object',
            'Upload already stored; complete it or reserve a new upload',
          );
        throw e;
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  async inspect(item: any) {
    if (this.s3) {
      const h = await this.s3.send(
        new HeadObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: this.key(item.id),
          ChecksumMode: 'ENABLED',
        }),
      );
      assert(
        h.VersionId && h.VersionId !== 'null',
        422,
        's3_versioning_required',
        'S3 bucket versioning must be enabled',
      );
      return { size_bytes: h.ContentLength!, object_version: h.VersionId };
    }
    const s = await stat(this.localPath(item.id));
    return { size_bytes: s.size, object_version: 'local-immutable-v1' };
  }
  async stream(item: any): Promise<Readable> {
    if (this.s3) {
      const r = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: this.key(item.id),
          VersionId: item.object_version,
        }),
      );
      return r.Body as Readable;
    }
    return createReadStream(this.localPath(item.id));
  }
  async digest(item: any) {
    const h = createHash('sha256');
    let size = 0;
    for await (const chunk of await this.stream(item)) {
      size += chunk.length;
      h.update(chunk);
    }
    return { sha256: h.digest('hex'), size_bytes: size };
  }
  async json(item: any) {
    assert(
      item.size_bytes <= this.config.MAX_JSON_BYTES,
      413,
      'json_too_large',
      'JSON evidence exceeds MAX_JSON_BYTES',
    );
    const buffers: Buffer[] = [];
    let size = 0;
    for await (const chunk of await this.stream(item)) {
      size += chunk.length;
      assert(
        size <= this.config.MAX_JSON_BYTES,
        413,
        'json_too_large',
        'JSON evidence exceeds limit',
      );
      buffers.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(buffers).toString('utf8'));
    } catch {
      throw new ApiError(422, 'invalid_json_artifact', 'Evidence is not valid JSON');
    }
  }
  async storeFile(id: string, filename: string) {
    if (this.s3) {
      const s = await stat(filename);
      const result = await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: this.key(id),
          Body: createReadStream(filename),
          ContentLength: s.size,
          ServerSideEncryption: 'AES256',
        }),
      );
      assert(
        result.VersionId && result.VersionId !== 'null',
        422,
        's3_versioning_required',
        'Enable S3 bucket versioning',
      );
      return result.VersionId;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await link(filename, this.localPath(id));
    return 'local-immutable-v1';
  }
}
