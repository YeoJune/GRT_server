import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetDimensionValuesCommand,
  type GetCostAndUsageCommandOutput,
  type GetDimensionValuesCommandOutput,
} from '@aws-sdk/client-cost-explorer';
import type { Database } from '../db/index.js';
import { assert } from '../util.js';

type Month = { month: string; internet_out_gb: number | null; estimated: boolean };
type Report = {
  status: 'ok';
  current_month: string;
  months: Month[];
  checked_at: string;
  period_start: string;
  period_end: string;
  source: 'aws_cost_explorer';
  scope: 'billing_account';
};
type Unavailable = {
  status: 'unavailable';
  current_month: string;
  checked_at: string;
  code: string;
  message: string;
};
const cacheId = 'aws-download-usage';
const cacheMs = 24 * 60 * 60 * 1000;
const internetUsage = /(?:^|-)DataTransfer-Out-Bytes$/;

export class DownloadUsage {
  private pending?: Promise<Report | Unavailable>;
  private failure?: { until: number; value: Unavailable };
  constructor(
    private db: Database,
    private client = new CostExplorerClient({ region: 'us-east-1' }),
    private clock: () => Date = () => new Date(),
  ) {}

  async get(): Promise<Report | Unavailable> {
    const now = this.clock(),
      month = now.toISOString().slice(0, 7);
    if (
      this.failure &&
      this.failure.until > now.getTime() &&
      this.failure.value.current_month === month
    )
      return this.failure.value;
    const saved = await this.db.get('settings', cacheId);
    if (
      saved?.report?.current_month === month &&
      now.getTime() - Date.parse(saved.report.checked_at) >= 0 &&
      now.getTime() - Date.parse(saved.report.checked_at) < cacheMs
    )
      return saved.report;
    // One instance serves all browser sessions; persist successful reads across restarts too.
    if (!this.pending)
      this.pending = this.refresh(now).finally(() => {
        this.pending = undefined;
      });
    const report = await this.pending;
    return report.current_month === month ? report : this.get();
  }

  private async refresh(now: Date): Promise<Report | Unavailable> {
    const current_month = now.toISOString().slice(0, 7);
    const months: Month[] = Array.from({ length: 12 }, (_, i) => {
      const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + i, 1))
        .toISOString()
        .slice(0, 7);
      return {
        month,
        internet_out_gb: month === current_month && now.getUTCDate() === 1 ? null : 0,
        estimated: month === current_month,
      };
    });
    const TimePeriod = { Start: months[0].month + '-01', End: now.toISOString().slice(0, 10) };
    try {
      const types = new Set<string>();
      const units = new Map<string, string | undefined>();
      const abortSignal = AbortSignal.timeout(30000);
      let token: string | undefined;
      const seen = new Set<string>();
      do {
        const page: GetDimensionValuesCommandOutput = await this.client.send(
          new GetDimensionValuesCommand({
            TimePeriod,
            Dimension: 'USAGE_TYPE',
            Context: 'COST_AND_USAGE',
            SearchString: 'DataTransfer-Out-Bytes',
            NextPageToken: token,
          }),
          { abortSignal },
        );
        for (const dimension of page.DimensionValues || [])
          if (dimension.Value && internetUsage.test(dimension.Value)) {
            types.add(dimension.Value);
            units.set(dimension.Value, dimension.Attributes?.unit);
          }
        token = page.NextPageToken;
        if (token) {
          assert(!seen.has(token), 502, 'invalid_aws_page', 'AWS pagination did not advance');
          seen.add(token);
        }
      } while (token);
      if (types.size) {
        token = undefined;
        seen.clear();
        do {
          const page: GetCostAndUsageCommandOutput = await this.client.send(
            new GetCostAndUsageCommand({
              TimePeriod,
              Granularity: 'MONTHLY',
              Metrics: ['UsageQuantity'],
              GroupBy: [{ Type: 'DIMENSION', Key: 'USAGE_TYPE' }],
              Filter: { Dimensions: { Key: 'USAGE_TYPE', Values: [...types] } },
              NextPageToken: token,
            }),
            { abortSignal },
          );
          for (const period of page.ResultsByTime || []) {
            const month = months.find((m) => m.month === period.TimePeriod?.Start?.slice(0, 7));
            if (!month) continue;
            month.estimated ||= !!period.Estimated;
            for (const group of period.Groups || []) {
              const metric = group.Metrics?.UsageQuantity;
              const amount = Number(metric?.Amount);
              const unit = units.get(group.Keys?.[0] || '');
              assert(
                types.has(group.Keys?.[0] || '') &&
                  (!unit || unit === 'GB') &&
                  (metric?.Unit === 'GB' || (metric?.Unit === 'N/A' && unit === 'GB')) &&
                  Number.isFinite(amount) &&
                  amount >= 0,
                502,
                'unsupported_aws_usage',
                'Unexpected AWS usage unit or quantity',
              );
              month.internet_out_gb = (month.internet_out_gb ?? 0) + amount;
            }
          }
          token = page.NextPageToken;
          if (token) {
            assert(!seen.has(token), 502, 'invalid_aws_page', 'AWS pagination did not advance');
            seen.add(token);
          }
        } while (token);
      }
      const report: Report = {
        status: 'ok',
        current_month,
        months: months.reverse(),
        checked_at: now.toISOString(),
        period_start: TimePeriod.Start,
        period_end: TimePeriod.End,
        source: 'aws_cost_explorer',
        scope: 'billing_account',
      };
      await this.db.write((tx) =>
        tx.put('settings', { id: cacheId, created_at: now.toISOString(), report }),
      );
      this.failure = undefined;
      return report;
    } catch (error: any) {
      const diagnostic = error?.code || error?.name || '';
      const value: Unavailable = {
        status: 'unavailable',
        current_month,
        checked_at: now.toISOString(),
        code: /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(diagnostic)
          ? diagnostic
          : 'aws_usage_unavailable',
        message:
          'AWS 사용량을 조회하지 못했습니다. Cost Explorer 활성화와 IAM 조회 권한을 확인하세요.',
      };
      this.failure = { until: this.clock().getTime() + 30000, value };
      return value;
    }
  }
}
