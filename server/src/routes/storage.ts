import { Router } from 'express';
import { stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../config.js';
import { resolveRoot, root } from '../config.js';
import type { Storage } from '../services/storage.js';
import type { DownloadUsage } from '../services/download-usage.js';

export async function diskUsage(c: Config) {
  const paths = [root, tmpdir(), resolveRoot(c.STORAGE_DIRECTORY)];
  if (c.DB_CLIENT === 'sqlite') paths.push(path.dirname(resolveRoot(c.SQLITE_FILENAME)));
  const disks = new Map<
    number,
    { paths: string[]; total_bytes: number; used_bytes: number; available_bytes: number }
  >();
  const errors: string[] = [];
  for (const requested of new Set(paths)) {
    try {
      let directory = requested;
      // A fresh install may not have an artifact directory yet; inspect its parent mount.
      let info;
      while (true) {
        try {
          info = await stat(directory);
          break;
        } catch (error: any) {
          if (error.code !== 'ENOENT' || directory === path.dirname(directory)) throw error;
          directory = path.dirname(directory);
        }
      }
      const existing = disks.get(info.dev);
      if (existing) {
        existing.paths.push(requested);
        continue;
      }
      const fs = await statfs(directory, { bigint: true });
      disks.set(info.dev, {
        paths: [requested],
        total_bytes: Number(fs.blocks * fs.bsize),
        used_bytes: Number((fs.blocks - fs.bfree) * fs.bsize),
        available_bytes: Number(fs.bavail * fs.bsize),
      });
    } catch {
      errors.push(requested);
    }
  }
  return { filesystems: [...disks.values()], errors, checked_at: new Date().toISOString() };
}

export function storageRoutes(c: Config, storage: Storage, downloads: DownloadUsage) {
  const r = Router();
  r.get('/storage/usage', async (_req, res) => {
    const [disk, s3] = await Promise.all([diskUsage(c), storage.usage()]);
    res.json({ driver: c.STORAGE_DRIVER, disk, s3 });
  });
  r.get('/usage/downloads', async (_req, res) => res.json(await downloads.get()));
  return r;
}
