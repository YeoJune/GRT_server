import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
export const now = () => new Date().toISOString();
export const id = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${randomBytes(10).toString('hex')}`;
export const secret = () => randomBytes(32).toString('base64url');
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export const secondsFromNow = (seconds: number) =>
  new Date(Date.now() + seconds * 1000).toISOString();
export function canonical(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public field_errors: any[] = [],
  ) {
    super(message);
  }
}
export function assert(
  condition: any,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new ApiError(status, code, message);
}
export function page(req: Request, res: Response, items: any[]) {
  const q = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    })
    .parse(req.query);
  let rows = items;
  if (q.cursor) {
    let cursor = '';
    try {
      cursor = Buffer.from(q.cursor, 'base64url').toString('utf8');
    } catch {
      /* rejected below */
    }
    assert(/^[\w-]+$/.test(cursor), 422, 'invalid_cursor', 'Invalid cursor');
    rows = rows.filter((row) => row.id < cursor);
  }
  const data = rows.slice(0, q.limit);
  res.json({
    data,
    next_cursor: rows.length > q.limit ? Buffer.from(data.at(-1).id).toString('base64url') : null,
  });
}
export function publicToken(t: any) {
  const { secret_hash, ...safe } = t;
  return safe;
}
