import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GetCostAndUsageCommand, GetDimensionValuesCommand } from '@aws-sdk/client-cost-explorer';
import { createDatabase } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import { DownloadUsage } from '../src/services/download-usage.js';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'grt-download-usage-'));
  const db = createDatabase(
    loadConfig({
      NODE_ENV: 'test',
      SQLITE_FILENAME: path.join(directory, 'db.sqlite'),
      STORAGE_SIGNING_KEY: 'k'.repeat(32),
    }),
  );
  await db.migrate();
  return {
    db,
    close: async () => {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('monthly AWS usage paginates, sums only internet GB and persists a cache across sessions/restarts', async () => {
  const f = await fixture();
  let time = new Date('2026-10-28T04:00:00Z'),
    calls = 0;
  const client: any = {
    send: async (command: any) => {
      calls++;
      assert.deepEqual(command.input.TimePeriod, { Start: '2025-11-01', End: '2026-10-28' });
      if (command instanceof GetDimensionValuesCommand) {
        assert.equal(command.input.SearchString, 'DataTransfer-Out-Bytes');
        return command.input.NextPageToken
          ? {
              DimensionValues: [
                { Value: 'US-DataTransfer-Out-Bytes', Attributes: { unit: 'GB' } },
                { Value: 'APN2-AWS-Out-Bytes', Attributes: { unit: 'GB' } },
              ],
            }
          : {
              DimensionValues: [
                { Value: 'APN2-DataTransfer-Out-Bytes', Attributes: { unit: 'GB' } },
              ],
              NextPageToken: 'dimensions-2',
            };
      }
      assert.ok(command instanceof GetCostAndUsageCommand);
      assert.deepEqual(command.input.Filter.Dimensions.Values.sort(), [
        'APN2-DataTransfer-Out-Bytes',
        'US-DataTransfer-Out-Bytes',
      ]);
      const group = (type: string, amount: string, unit = 'GB') => ({
        Keys: [type],
        Metrics: { UsageQuantity: { Amount: amount, Unit: unit } },
      });
      return command.input.NextPageToken
        ? {
            ResultsByTime: [
              {
                TimePeriod: { Start: '2026-10-01' },
                Groups: [group('US-DataTransfer-Out-Bytes', '2.5', 'N/A')],
              },
            ],
          }
        : {
            ResultsByTime: [
              {
                TimePeriod: { Start: '2026-10-01' },
                Estimated: true,
                Groups: [group('APN2-DataTransfer-Out-Bytes', '10')],
              },
              {
                TimePeriod: { Start: '2026-09-01' },
                Estimated: false,
                Groups: [group('APN2-DataTransfer-Out-Bytes', '42')],
              },
            ],
            NextPageToken: 'usage-2',
          };
    },
  };
  try {
    const service = new DownloadUsage(f.db, client, () => time);
    const [first, same] = await Promise.all([service.get(), service.get()]);
    assert.deepEqual(first, same);
    assert.equal(first.status, 'ok');
    if (first.status !== 'ok') throw new Error('expected usage report');
    assert.equal(first.months[0].internet_out_gb, 12.5);
    assert.equal(first.months[1].internet_out_gb, 42);
    assert.equal(first.months.length, 12);
    assert.equal(first.months[0].estimated, true);
    assert.equal(calls, 4);
    assert.deepEqual(await new DownloadUsage(f.db, client, () => time).get(), first);
    assert.equal(calls, 4);
    time = new Date('2026-10-28T23:59:00Z');
    assert.deepEqual(await service.get(), first);
    assert.equal(calls, 4);
  } finally {
    await f.close();
  }
});

test('UTC month rollover refreshes before cache expiry and shows a pending current month on day one', async () => {
  const f = await fixture();
  let time = new Date('2026-12-31T23:59:00Z'),
    calls = 0;
  const client: any = {
    send: async (command: any) => {
      calls++;
      assert.ok(command instanceof GetDimensionValuesCommand);
      return { DimensionValues: [] };
    },
  };
  try {
    const service = new DownloadUsage(f.db, client, () => time);
    const old = await service.get();
    assert.equal(old.current_month, '2026-12');
    time = new Date('2027-01-01T00:01:00Z');
    const fresh = await service.get();
    assert.equal(fresh.status, 'ok');
    if (fresh.status !== 'ok') throw new Error('expected usage report');
    assert.equal(fresh.current_month, '2027-01');
    assert.equal(fresh.months[0].internet_out_gb, null);
    assert.equal(fresh.months[1].month, '2026-12');
    assert.equal(fresh.period_start, '2026-02-01');
    assert.equal(fresh.period_end, '2027-01-01');
    assert.equal(calls, 2);
    time = new Date('2027-01-02T00:02:00Z');
    const next = await service.get();
    assert.equal(calls, 3);
    assert.ok(next.status === 'ok' && next.months[0].internet_out_gb === 0);
  } finally {
    await f.close();
  }
});

test('AWS access/unit failures remain unavailable rather than zero, and can be retried after cooldown', async () => {
  const f = await fixture();
  let time = new Date('2026-10-28T04:00:00Z'),
    calls = 0,
    deny = true;
  const client: any = {
    send: async (command: any) => {
      calls++;
      if (deny)
        throw Object.assign(new Error('sensitive AWS diagnostic'), {
          name: 'AccessDeniedException',
        });
      if (command instanceof GetDimensionValuesCommand)
        return { DimensionValues: [{ Value: 'APN2-DataTransfer-Out-Bytes' }] };
      return {
        ResultsByTime: [
          {
            TimePeriod: { Start: '2026-10-01' },
            Groups: [
              {
                Keys: ['APN2-DataTransfer-Out-Bytes'],
                Metrics: { UsageQuantity: { Amount: '200', Unit: 'Hrs' } },
              },
            ],
          },
        ],
      };
    },
  };
  try {
    const service = new DownloadUsage(f.db, client, () => time);
    const denied = await service.get();
    assert.equal(denied.status, 'unavailable');
    assert.ok(!JSON.stringify(denied).includes('sensitive'));
    assert.equal((denied as any).months, undefined);
    await service.get();
    assert.equal(calls, 1);
    assert.equal(await f.db.get('settings', 'aws-download-usage'), undefined);
    deny = false;
    time = new Date('2026-10-28T04:01:00Z');
    const invalid = await service.get();
    assert.equal(invalid.status, 'unavailable');
    assert.equal((invalid as any).code, 'unsupported_aws_usage');
    assert.equal(await f.db.get('settings', 'aws-download-usage'), undefined);
  } finally {
    await f.close();
  }
});
