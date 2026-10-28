import { createHmac, createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, stat, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
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
  private usageCache?: { expires: number; value: Promise<unknown> };
  readonly directory: string;
  readonly receiving = new Map<string, number>();
  constructor(public config: Config) {
    this.directory = resolveRoot(config.STORAGE_DIRECTORY);
    if (config.STORAGE_DRIVER === 's3') this.s3 = new S3Client({ region: config.AWS_REGION });
  }
  private key(id: string) {
    assert(/^[\w-]+$/.test(id), 422, 'invalid_id', 'Invalid artifact ID');
    return `${this.config.S3_PREFIX}${id}`;
  }
  async usage() {
    if (!this.s3) return { status: 'disabled' as const };
    if (this.usageCache && this.usageCache.expires > Date.now()) return this.usageCache.value;
    const value = this.measureUsage();
    // Share in-flight scans and avoid listing every version on each browser refresh.
    this.usageCache = { expires: Date.now() + 300000, value };
    return value;
  }
  private async measureUsage() {
    const base = {
      bucket: this.config.S3_BUCKET,
      prefix: this.config.S3_PREFIX,
      budget_bytes: this.config.S3_BUDGET_BYTES,
    };
    try {
      let current_bytes = 0,
        noncurrent_bytes = 0,
        object_count = 0,
        version_count = 0,
        delete_markers = 0;
      let keyMarker: string | undefined, versionMarker: string | undefined;
      const abortSignal = AbortSignal.timeout(30000);
      do {
        const page = await this.s3!.send(
          new ListObjectVersionsCommand({
            Bucket: this.config.S3_BUCKET,
            Prefix: this.config.S3_PREFIX,
            KeyMarker: keyMarker,
            VersionIdMarker: versionMarker,
            MaxKeys: 1000,
          }),
          { abortSignal },
        );
        for (const item of page.Versions || []) {
          version_count++;
          if (item.IsLatest) {
            current_bytes += item.Size || 0;
            object_count++;
          } else noncurrent_bytes += item.Size || 0;
        }
        delete_markers += page.DeleteMarkers?.length || 0;
        if (!page.IsTruncated) break;
        assert(
          page.NextKeyMarker &&
            (page.NextKeyMarker !== keyMarker || page.NextVersionIdMarker !== versionMarker),
          502,
          'invalid_storage_page',
          'S3 version listing did not advance',
        );
        keyMarker = page.NextKeyMarker;
        versionMarker = page.NextVersionIdMarker;
      } while (true);
      return {
        ...base,
        status: 'ok' as const,
        used_bytes: current_bytes + noncurrent_bytes,
        current_bytes,
        noncurrent_bytes,
        object_count,
        version_count,
        delete_markers,
        checked_at: new Date().toISOString(),
      };
    } catch {
      // Never expose SDK diagnostics, signed URLs, or credential details to clients.
      if (this.usageCache) this.usageCache.expires = Date.now() + 15000;
      return {
        ...base,
        status: 'error' as const,
        checked_at: new Date().toISOString(),
        message: 'S3 사용량을 조회하지 못했습니다. IAM 권한과 서버 설정을 확인하세요.',
      };
    }
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
  async receive(
    id: string,
    stream: Readable,
    expectedSize: number,
    canPublish?: () => Promise<boolean>,
  ) {
    assert(!this.s3, 404, 'not_found', 'Use the S3 upload URL');
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
    this.receiving.set(id, (this.receiving.get(id) || 0) + 1);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await pipeline(stream, limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      assert(bytes === expectedSize, 422, 'size_mismatch', 'Upload differs from declared size');
      assert(!canPublish || (await canPublish()), 409, 'upload_closed', 'Upload is no longer open');
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
      const remaining = this.receiving.get(id)! - 1;
      if (remaining) this.receiving.set(id, remaining);
      else this.receiving.delete(id);
    }
  }
  async remove(item: { id: string }) {
    if (!this.s3) {
      try {
        await unlink(this.localPath(item.id));
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
      }
      return;
    }
    const key = this.key(item.id);
    // Delete all versions, including delete markers; a plain S3 delete retains bytes.
    while (true) {
      const page = await this.s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.config.S3_BUCKET,
          Prefix: key,
          MaxKeys: 1000,
        }),
      );
      const objects = [...(page.Versions || []), ...(page.DeleteMarkers || [])]
        .filter((v) => v.Key === key)
        .map((v) => ({ Key: v.Key!, VersionId: v.VersionId! }));
      if (!objects.length) return;
      const result = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.config.S3_BUCKET,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
      assert(
        !result.Errors?.length,
        503,
        'storage_delete_failed',
        'Object versions could not be deleted',
      );
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
    // ZIP staging may be on /tmp (tmpfs), while artifacts live on an EBS mount.
    // Copy fully onto the destination filesystem before publishing immutable bytes.
    const temporary = path.join(this.directory, `.export-${secret()}`);
    try {
      await copyFile(filename, temporary, constants.COPYFILE_EXCL);
      await link(temporary, this.localPath(id));
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return 'local-immutable-v1';
  }
}
