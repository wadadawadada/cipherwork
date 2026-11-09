import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.ESCROW_CONTRACT_ID = 'cipherwork-escrow.testnet';
process.env.RELAYER_ACCOUNT_ID = 'relayer.testnet';
process.env.RELAYER_PRIVATE_KEY = 'ed25519:' + '1'.repeat(88);
process.env.TREASURY_ACCOUNT_ID = 'relayer.testnet';
process.env.VERIFIER_KEY_ID = 'test-key';
process.env.VERIFIER_SEED_HEX = '11'.repeat(32);
process.env.PROVIDER_ACCOUNT_ID = 'provider.testnet';
process.env.DATABASE_URL = '';
process.env.DRIP_ENABLED = 'false';

let app: any;
let v: typeof import('../src/verifier.js');
let guards: typeof import('../src/schemas.js');

beforeAll(async () => {
  const priv = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(process.env.VERIFIER_SEED_HEX!, 'hex')]),
    format: 'der',
    type: 'pkcs8',
  });
  process.env.VERIFIER_PUBLIC_KEY_HEX = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const { buildApp } = await import('../src/app.js');
  const { MemoryStore } = await import('../src/store.js');
  app = await buildApp(new MemoryStore());
  v = await import('../src/verifier.js');
  guards = await import('../src/schemas.js');
});

describe('T05_api_leak: metadata endpoints reject private-looking fields', () => {
  for (const field of ['prompt', 'document', 'messages', 'content', 'apiKey', 'file']) {
    it(`rejects "${field}" with 400 and never echoes the value`, async () => {
      const secret = 'TOP-SECRET-VALUE-12345';
      const r = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: { productId: 'private_ai_inference.v1', offerId: 'x', buyerAccountId: 'a.testnet', [field]: secret },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('PRIVATE_FIELD_REJECTED');
      expect(r.body).not.toContain(secret);
    });
  }
  it('rejects nested private fields', () => {
    expect(() => guards.assertNoPrivateFields({ a: { b: { prompt: 'x' } } })).toThrow();
  });
  it('rejects unknown fields on strict schemas', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/orders',
      payload: { jobId: 'cw_12345678', quoteId: 'q_12345678', fundTxHash: 'x'.repeat(44), extra: 1 },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('verdict signing matches the contract message format', () => {
  const verdict = {
    order_id: 'cw_abcdef12',
    outcome: 'verified' as const,
    proof_digest: 'pd',
    request_binding_digest: 'rb',
    expiry_ms: 123,
    verifier_key_id: 'test-key',
  };
  it('canonical message layout', () => {
    expect(v.verdictMessage('c.testnet', verdict)).toBe('cipherwork.near.testnet.v1|c.testnet|testnet|cw_abcdef12|verified|pd|rb|123');
  });
  it('signature verifies; tampering or wrong contract fails', () => {
    const sig = v.signVerdict(verdict);
    expect(v.verifyVerdictSignature(process.env.ESCROW_CONTRACT_ID!, verdict, sig)).toBe(true);
    expect(v.verifyVerdictSignature(process.env.ESCROW_CONTRACT_ID!, { ...verdict, outcome: 'rejected' }, sig)).toBe(false);
    expect(v.verifyVerdictSignature('other.testnet', verdict, sig)).toBe(false);
  });
});

describe('verifier fails closed (offline)', () => {
  const att = {
    nonce: 'a'.repeat(64),
    signer: { signingAlgo: 'ed25519' as const, signingAddress: 'b'.repeat(64) },
    intelQuote: 'c'.repeat(200),
    eventLog: '[]',
    appCompose: '{}',
  };
  const bundle = (over: any = {}) =>
    guards.ProofBundle.parse({
      jobId: 'cw_12345678',
      offerId: 'offer-1',
      model: 'm/x',
      preflight: { nonce: 'a'.repeat(64), attestations: [att], performedAtMs: 1 },
      completion: {
        completionId: 'abcd1234',
        signature: { kind: 'provider_tee', signer: att.signer, signedText: `m/x:${'0'.repeat(64)}:${'0'.repeat(64)}`, signature: 'd'.repeat(128) },
      },
      ...over,
    });
  const failingTdx = (async () => {
    throw new Error('bad quote');
  }) as any;
  it('T04: unverifiable quote -> ATTESTATION_INVALID', async () => {
    const r = await v.verifyProofBundle(bundle(), { jobId: 'cw_12345678', offerId: 'offer-1', model: 'm/x' }, { tdxQuote: failingTdx, gpu: (async () => {}) as any });
    expect(r.ok).toBe(false);
    expect(r.failureCode).toBe('ATTESTATION_INVALID');
  });
  it('model/job mismatch -> MODEL_NOT_ALLOWED', async () => {
    const r = await v.verifyProofBundle(bundle(), { jobId: 'cw_12345678', offerId: 'offer-1', model: 'other/model' }, { tdxQuote: failingTdx });
    expect(r.failureCode).toBe('MODEL_NOT_ALLOWED');
  });
  it('bundle schema rejects plaintext-looking extra fields', () => {
    expect(() => bundle({ prompt: 'hello' })).toThrow();
    expect(() => bundle({ completion: { completionId: 'abcd1234', text: 'answer', signature: bundle().completion.signature } })).toThrow();
  });
});

describe('API surface', () => {
  it('demo offer is labelled and unavailable', async () => {
    const o = await app.inject({ url: '/v1/products/private_ai_inference.v1/offers' });
    const demo = o.json().offers.find((x: any) => x.id === 'demo-outage-simulator');
    expect(demo.kind).toBe('demo');
    expect(demo.status).toBe('unavailable');
  });
  it('T09: unavailable offer cannot be quoted (PROVIDER_UNAVAILABLE)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: { productId: 'private_ai_inference.v1', offerId: 'demo-outage-simulator', buyerAccountId: 'a.testnet' },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('PROVIDER_UNAVAILABLE');
  });
  it('drip endpoint is disabled by default', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/dev/drip', payload: { accountId: 'a'.repeat(64) } });
    expect(r.statusCode).toBe(404);
  });
  it('sha256 sanity', () => {
    expect(createHash('sha256').update('a').digest('hex')).toHaveLength(64);
  });
});
