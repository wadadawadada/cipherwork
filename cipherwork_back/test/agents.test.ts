import { describe, it, expect, beforeAll } from 'vitest';
import { KeyPair } from 'near-api-js';

process.env.NODE_ENV = 'test';
process.env.ESCROW_CONTRACT_ID = 'cipherwork-escrow.testnet';
process.env.RELAYER_ACCOUNT_ID = 'relayer.testnet';
process.env.RELAYER_PRIVATE_KEY = 'ed25519:' + '1'.repeat(88);
process.env.TREASURY_ACCOUNT_ID = 'relayer.testnet';
process.env.VERIFIER_KEY_ID = 'test-key';
process.env.VERIFIER_SEED_HEX = '11'.repeat(32);
process.env.VERIFIER_PUBLIC_KEY_HEX = '22'.repeat(32);
process.env.PROVIDER_ACCOUNT_ID = 'provider.testnet';
process.env.DATABASE_URL = '';

const N = 10n ** 24n;
const near = (milli: number) => ((BigInt(milli) * N) / 1000n).toString();
let app: any;
let schemas: typeof import('../src/schemas.js');
const kp = KeyPair.fromRandom('ed25519');
const ACCOUNT = 'agent-one.testnet';

function signed(over: Record<string, unknown> = {}, key = kp) {
  const base = { accountId: ACCOUNT, name: 'Research Bot', policy: { maxPerJobYocto: near(25), dailyCapYocto: near(60), allowedOffers: ['near-ai-glm-5.3-flash'] }, timestampMs: Date.now(), ...over } as any;
  const msg = schemas.agentMessage(base);
  const sig = key.sign(new TextEncoder().encode(msg));
  return { ...base, publicKey: key.getPublicKey().toString(), signature: Buffer.from(sig.signature).toString('hex') };
}
const register = (payload: any) => app.inject({ method: 'POST', url: '/v1/agents', payload });
const quote = (offerId: string, buyer = ACCOUNT) => app.inject({ method: 'POST', url: '/v1/quotes', payload: { productId: 'private_ai_inference.v1', offerId, buyerAccountId: buyer } });

beforeAll(async () => {
  schemas = await import('../src/schemas.js');
  const { buildApp } = await import('../src/app.js');
  const { MemoryStore } = await import('../src/store.js');
  // key ownership check is stubbed offline: only kp's key belongs to ACCOUNT
  app = await buildApp(new MemoryStore(), { keyBelongsToAccount: async (acc, pk) => acc === ACCOUNT && pk === kp.getPublicKey().toString() });
});

describe('agent registration is signed by the agent', () => {
  it('accepts a valid signature and exposes the agent', async () => {
    const r = await register(signed());
    expect(r.statusCode).toBe(201);
    const list = (await app.inject({ url: '/v1/agents' })).json();
    expect(list.agents[0].accountId).toBe(ACCOUNT);
  });
  it('rejects a tampered policy (signature no longer matches)', async () => {
    const p = signed();
    p.policy.dailyCapYocto = near(5000);
    expect((await register(p)).statusCode).toBe(401);
  });
  it('rejects a key that is not an access key of the account', async () => {
    const other = KeyPair.fromRandom('ed25519');
    expect((await register(signed({}, other))).statusCode).toBe(401);
  });
  it('rejects stale timestamps and per-job cap above the daily cap', async () => {
    expect((await register(signed({ timestampMs: Date.now() - 3600_000 }))).statusCode).toBe(400);
    expect((await register(signed({ policy: { maxPerJobYocto: near(90), dailyCapYocto: near(10), allowedOffers: [] } }))).statusCode).toBe(400);
  });
});

describe('policy is enforced at quote time', () => {
  it('allows an in-policy quote', async () => {
    expect((await quote('near-ai-glm-5.3-flash')).statusCode).toBe(200);
  });
  it('blocks an offer outside the allow-list (403 POLICY_VIOLATION)', async () => {
    const r = await quote('near-ai-qwen3.8-27b');
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('POLICY_VIOLATION');
  });
  it('blocks when the price is above the per-job cap', async () => {
    await register(signed({ policy: { maxPerJobYocto: near(10), dailyCapYocto: near(60), allowedOffers: [] } }));
    const r = await quote('near-ai-glm-5.3-flash');
    expect(r.statusCode).toBe(403);
    expect(r.json().message).toMatch(/per-job cap/);
  });
  it('blocks when outstanding quotes would exceed the 24h budget', async () => {
    await register(signed({ policy: { maxPerJobYocto: near(25), dailyCapYocto: near(50), allowedOffers: ['near-ai-glm-5.3-flash'] } }));
    // 0.020 + 0.020 already outstanding from earlier quotes in this test run -> a third (0.020) exceeds 0.050
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await quote('near-ai-glm-5.3-flash')).statusCode);
    expect(results).toContain(403);
  });
  it('agents without a policy are not restricted', async () => {
    expect((await quote('near-ai-glm-5.3-flash', 'someone-else.testnet')).statusCode).toBe(200);
  });
  it('records refused quotes with the reason', async () => {
    const e = (await app.inject({ url: '/v1/policy-events' })).json().events;
    expect(e.length).toBeGreaterThan(0);
    expect(e[0]).toMatchObject({ accountId: ACCOUNT });
    expect(e[0].reason.length).toBeGreaterThan(10);
  });
  it('counts blocked requests', async () => {
    expect((await app.inject({ url: '/v1/agents' })).json().blockedByPolicy).toBeGreaterThan(0);
  });
});

describe('marketplace', () => {
  it('lists offers with stats', async () => {
    const r = (await app.inject({ url: '/v1/marketplace' })).json();
    expect(r.offers.length).toBeGreaterThan(1);
    expect(r.offers[0].stats).toHaveProperty('jobs');
  });
});
