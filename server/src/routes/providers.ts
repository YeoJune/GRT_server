import { Router } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { writeOnly } from '../auth.js';
import { ApiError, assert, parse } from '../util.js';

export function providerRoutes(c: Config) {
  const r = Router();
  r.post('/providers/vast/offers/search', async (req, res) => {
    const query = parse(z.object({ query: z.record(z.unknown()) }).strict(), req.body);
    assert(
      c.VAST_API_KEY,
      503,
      'provider_not_configured',
      'Set VAST_API_KEY on the server to enable offer search',
    );
    try {
      const response = await fetch('https://console.vast.ai/api/v0/bundles', {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.VAST_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(query.query),
        signal: AbortSignal.timeout(15000),
      });
      assert(response.ok, 502, 'provider_error', 'Vast offer search failed');
      res.json(await response.json());
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(502, 'provider_unavailable', 'Vast offer search unavailable');
    }
  });
  r.get('/allocations', (_req, res) => res.json({ data: [], next_cursor: null, enabled: false }));
  r.post(['/allocations', '/allocations/:id/actions', '/workers/enroll'], writeOnly, () => {
    throw new ApiError(
      501,
      'allocation_not_enabled',
      'Paid allocations require independent deadline monitoring and bootstrap enrollment; this release does not create paid GPU instances',
    );
  });
  r.get(['/allocations/:id', '/operations/:id'], () => {
    throw new ApiError(404, 'not_found', 'Operation/allocation not found');
  });
  return r;
}
