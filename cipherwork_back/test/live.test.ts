import { describe, it, expect } from 'vitest';
import * as sdk from '@nearai/inference-sdk/node';
import { preflight, PreflightError } from '../sdk/privateJob.js';

// Network-gated: LIVE=1 npx vitest run test/live.test.ts. Needs no API key (public attestation only).
describe.skipIf(!process.env.LIVE)('live attestation', () => {
  const baseUrl = 'https://cloud-api.near.ai/v1';
  const model = 'z-ai/glm-5.3-flash';
  it('T01_real_attestation', async () => {
    const p = await preflight(sdk as any, { baseUrl, model });
    expect(p.verified.length).toBeGreaterThan(0);
    expect(p.checks.filter((c) => c.status === 'failed')).toHaveLength(0);
  }, 120_000);
  it('T02_replay: wrong nonce is rejected', async () => {
    await expect(preflight(sdk as any, { baseUrl, model, fault: 'wrong_nonce' })).rejects.toBeInstanceOf(PreflightError);
  }, 120_000);
  it('tampered quote is rejected', async () => {
    await expect(preflight(sdk as any, { baseUrl, model, fault: 'tampered_quote' })).rejects.toBeInstanceOf(PreflightError);
  }, 120_000);
});
