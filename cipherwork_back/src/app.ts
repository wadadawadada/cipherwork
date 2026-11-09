import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { liveOffers, OFFERS, VERIFICATION_POLICY } from './offers.js';
import { explorerAccount, explorerTx, provider, relayer, txHashOf, view } from './near.js';
import {
  agentMessage, AgentRegister, assertNoPrivateFields, ClientReject, OrderCreate, PRODUCT_ID, PrivateFieldRejected, ProofBundle, QuoteRequest,
  type FailureCode,
} from './schemas.js';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { PublicKey } from 'near-api-js';
import type { AgentRecord } from './store.js';
import type { OrderRecord, QuoteRecord, Store } from './store.js';
import { makeVerdict, signVerdict, verifyProofBundle, type VerifierResult } from './verifier.js';

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const STORAGE_RESERVE = 10n ** 22n; // 0.01 NEAR covers the contract's on-chain storage fee

type ChainOrder = {
  order_id: string; buyer: string; provider: string; max_pay: string; storage_fee: string; deadline_ms: number;
  quote_digest: string; status: 'funded' | 'settled' | 'rejected' | 'refunded'; proof_digest?: string;
  provider_amount?: string; fee_amount?: string; verifier_key_id?: string; finalized_ms?: number;
};

export type TrustStatement = typeof TRUST;
export const TRUST = {
  label: 'Trust: CIPHERWORK authorized verifier',
  text: 'The escrow contract does not verify Intel TDX / NVIDIA attestation on-chain. It pays out only on a verdict signed by one authorized verifier key, which re-verifies the public evidence off-chain. The verifier never sees prompts or answers.',
};

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
async function defaultKeyBelongs(accountId: string, publicKey: string): Promise<boolean> {
  try { await provider.viewAccessKey({ accountId, publicKey }); return true; } catch { return false; }
}

export type AppDeps = { keyBelongsToAccount?: (accountId: string, publicKey: string) => Promise<boolean> };

export async function buildApp(store: Store, deps: AppDeps = {}): Promise<FastifyInstance> {
  const keyBelongs = deps.keyBelongsToAccount ?? defaultKeyBelongs;
  const counters = { blocked: 0 };
  const policyEvents: { at: number; accountId: string; offerId: string; reason: string }[] = [];
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'test' ? 'silent' : 'info',
      // Redacted structured logs: method + path only. No query strings, no bodies, no headers.
      serializers: {
        req: (r) => ({ method: r.method, path: (r.url ?? '').split('?')[0] }),
        res: (r) => ({ status: r.statusCode }),
      },
      redact: ['req.headers', 'res.headers'],
    },
    bodyLimit: 8 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  const origins = config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  await app.register(cors, { origin: origins, methods: ['GET', 'POST'], allowedHeaders: ['content-type', 'idempotency-key'], maxAge: 600 });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof PrivateFieldRejected) {
      req.log.warn({ code: 'PRIVATE_FIELD_REJECTED', path: err.path }, 'rejected private-looking field');
      return reply.code(400).send({ error: 'PRIVATE_FIELD_REJECTED', message: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code ?? 'BAD_REQUEST', message: err.message });
    req.log.error({ code: err.code }, 'internal error');
    return reply.code(500).send({ error: 'INTERNAL', message: 'Internal error' });
  });

  /** Privacy guard for metadata endpoints: strict schema AFTER a forbidden-field scan. */
  const parse = <T extends z.ZodTypeAny>(schema: T, body: unknown, scan = true): z.infer<T> => {
    if (scan) assertNoPrivateFields(body);
    return schema.parse(body);
  };


  /** Spend in the last 24h: funded/settled orders plus still-valid quotes that have no order yet. */
  async function spentLast24h(accountId: string): Promise<{ spent: bigint; jobs: number }> {
    const since = Date.now() - 24 * 3600_000;
    const orders = (await store.listOrders(1000)).filter((o) => o.buyerAccountId === accountId && o.createdAtMs > since && ['funded', 'settled', 'verified'].includes(o.status));
    const withOrder = new Set(orders.map((o) => o.jobId));
    const quotes = (await store.listQuotesBy(accountId, since)).filter((q) => q.expiresAtMs > Date.now() && !withOrder.has(q.jobId));
    const spent = orders.reduce((a, o) => a + BigInt(o.amountYoctoNear), 0n) + quotes.reduce((a, q) => a + BigInt(q.maxPayYoctoNear), 0n);
    return { spent, jobs: orders.length };
  }
  async function policyViolation(agent: AgentRecord, offerId: string, price: bigint): Promise<string | null> {
    const p = agent.policy;
    if (p.allowedOffers.length && !p.allowedOffers.includes(offerId)) return `Offer ${offerId} is not allowed by this agent's policy.`;
    if (price > BigInt(p.maxPerJobYocto)) return 'Price exceeds this agent\'s per-job cap.';
    const { spent } = await spentLast24h(agent.accountId);
    if (spent + price > BigInt(p.dailyCapYocto)) return 'This job would exceed the agent\'s 24h budget.';
    return null;
  }

  const chainOrder = async (jobId: string) => (await view<ChainOrder | null>('get_order', { order_id: jobId })) ?? undefined;

  /** Source of truth is the contract; the DB row is just an index. */
  async function refresh(rec: OrderRecord): Promise<OrderRecord> {
    if (rec.status === 'settled' || rec.status === 'rejected' || rec.status === 'refunded') return rec;
    const co = await chainOrder(rec.jobId).catch(() => undefined);
    if (!co) return rec;
    const map: Record<string, OrderRecord['status']> = { funded: 'funded', settled: 'settled', rejected: 'rejected', refunded: 'refunded' };
    const next = map[co.status];
    if (next && next !== rec.status) {
      rec.status = next;
      rec.timeline.push({ at: Date.now(), event: `chain:${co.status}` });
      if (co.proof_digest) rec.proofDigest = co.proof_digest;
      if (co.fee_amount) rec.protocolFeeYoctoNear = co.fee_amount;
      rec.updatedAtMs = Date.now();
      await store.putOrder(rec);
    } else if (rec.status === 'funded' && Date.now() > co.deadline_ms + 10_000 && co.status === 'funded') {
      // Deadline passed with no settlement: buyer can refund independently of this backend.
      rec.failureCode = 'SETTLEMENT_TIMEOUT';
    }
    return rec;
  }

  const receipt = (r: OrderRecord) => ({
    jobId: r.jobId, offerId: r.offerId, buyerAccountId: r.buyerAccountId, status: r.status, amountYoctoNear: r.amountYoctoNear,
    protocolFeeYoctoNear: r.protocolFeeYoctoNear ?? null,
    fundTxHash: r.fundTxHash ?? null, settleTxHash: r.settleTxHash ?? null,
    fundTxUrl: r.fundTxHash ? explorerTx(r.fundTxHash) : null,
    settleTxUrl: r.settleTxHash ? explorerTx(r.settleTxHash) : null,
    proofDigest: r.proofDigest ?? null, verdictKeyId: r.verdictKeyId ?? null,
    outcome: r.outcome ?? null, failureCode: r.failureCode ?? null,
    contractId: config.ESCROW_CONTRACT_ID, contractUrl: explorerAccount(config.ESCROW_CONTRACT_ID),
    trust: TRUST.label, createdAtMs: r.createdAtMs,
  });

  // ---------------------------------------------------------------- public metadata
  app.get('/health', async () => ({
    status: 'ok', store: store.kind, network: config.NEAR_NETWORK, escrow: config.ESCROW_CONTRACT_ID,
    chain: await fetch(config.NEAR_RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: [] }), signal: AbortSignal.timeout(4000) }).then((r) => (r.ok ? 'reachable' : 'unreachable')).catch(() => 'unreachable'),
    db: (await store.ping()) ? 'ok' : 'down',
  }));

  app.get('/v1/capabilities', async () => ({
    product: PRODUCT_ID, network: 'testnet', payment: 'NEAR testnet (public, not private)',
    endpoints: ['/v1/products', '/v1/products/{id}/offers', '/v1/quotes', '/v1/orders', '/v1/orders/{jobId}', '/v1/orders/{jobId}/proof', '/v1/proof-policy/{id}', '/v1/receipts/{jobId}', '/v1/verifier'],
    plaintextThroughApi: false, token: 'none',
  }));

  app.get('/v1/products', async () => ({
    products: [{
      id: PRODUCT_ID, version: '1.0', inputSchemaId: 'cipherwork.private_ai_inference.input.v1', outputSchemaId: 'cipherwork.private_ai_inference.output.v1',
      privacyRequirements: ['tee_attestation', 'signed_response'],
      note: 'Inputs are defined for the buyer-side direct call to the TEE. This API never accepts them.',
    }],
  }));

  app.get('/v1/products/:productId/offers', async (req, reply) => {
    const { productId } = req.params as { productId: string };
    if (productId !== PRODUCT_ID) return reply.code(404).send({ error: 'PRODUCT_NOT_FOUND' });
    return { offers: await liveOffers() };
  });

  app.get('/v1/proof-policy/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id !== VERIFICATION_POLICY.id) return reply.code(404).send({ error: 'POLICY_NOT_FOUND' });
    return { policy: VERIFICATION_POLICY, trust: TRUST };
  });

  app.get('/v1/verifier', async () => ({
    keyId: config.VERIFIER_KEY_ID, publicKeyHex: config.VERIFIER_PUBLIC_KEY_HEX, algorithm: 'ed25519',
    domain: 'cipherwork.near.testnet.v1', contractId: config.ESCROW_CONTRACT_ID, trust: TRUST,
    onchain: await view('get_config').catch(() => null),
  }));

  // ---------------------------------------------------------------- quotes
  app.post('/v1/quotes', async (req, reply) => {
    const body = parse(QuoteRequest, req.body);
    const offers = await liveOffers();
    const offer = offers.find((o) => o.id === body.offerId);
    if (!offer) return reply.code(404).send({ error: 'OFFER_NOT_FOUND' });
    if (offer.status === 'unavailable') return reply.code(409).send({ error: 'PROVIDER_UNAVAILABLE' satisfies FailureCode, message: `${offer.label} is unavailable${offer.kind === 'demo' ? ' (demo simulator)' : ''}.` });
    if (offer.status === 'degraded') return reply.code(409).send({ error: 'PROVIDER_UNAVAILABLE' satisfies FailureCode, message: 'Model catalog unreachable; cannot confirm availability.' });
    if (body.maxInputBytes > offer.maxInputBytes) return reply.code(400).send({ error: 'MODEL_NOT_ALLOWED', message: `maxInputBytes exceeds the offer limit ${offer.maxInputBytes}` });
    const price = BigInt(offer.maxCostYoctoNear);
    if (body.maxPayYoctoNear && BigInt(body.maxPayYoctoNear) < price) return reply.code(409).send({ error: 'PAYMENT_FAILED', message: 'Your price cap is below the offer price.' });

    const agent = await store.getAgent(body.buyerAccountId);
    if (agent) {
      const why = await policyViolation(agent, offer.id, price);
      if (why) { counters.blocked++; policyEvents.unshift({ at: Date.now(), accountId: body.buyerAccountId, offerId: offer.id, reason: why }); policyEvents.length = Math.min(policyEvents.length, 200); return reply.code(403).send({ error: 'POLICY_VIOLATION' satisfies FailureCode, message: why }); }
    }

    const now = Date.now();
    const jobId = `cw_${randomBytes(12).toString('hex')}`;
    const deadlineMs = now + 20 * 60_000;
    const base = {
      jobId, offerId: offer.id, modelId: offer.modelId, buyerAccountId: body.buyerAccountId, providerAccountId: offer.providerAccountId,
      maxPayYoctoNear: price.toString(), deadlineMs, escrowContractId: config.ESCROW_CONTRACT_ID,
    };
    const quoteDigest = sha256hex(JSON.stringify(base));
    const q: QuoteRecord = {
      quoteId: `q_${randomBytes(10).toString('hex')}`, ...base,
      depositYoctoNear: (price + STORAGE_RESERVE).toString(), expiresAtMs: now + 5 * 60_000, quoteDigest, createdAtMs: now,
    };
    await store.putQuote(q);
    return { quote: q, feeBps: config.FEE_BPS, trust: TRUST, note: 'Fund the order with the deposit shown, then run the private job directly against the TEE. This API never sees your input.' };
  });

  // ---------------------------------------------------------------- orders
  app.post('/v1/orders', async (req, reply) => {
    const body = parse(OrderCreate, req.body);
    const existing = await store.getOrder(body.jobId);
    if (existing) return { receipt: receipt(await refresh(existing)), idempotent: true };
    const q = await store.getQuote(body.quoteId);
    if (!q || q.jobId !== body.jobId) return reply.code(404).send({ error: 'QUOTE_NOT_FOUND' });
    const co = await chainOrder(body.jobId);
    if (!co) return reply.code(402).send({ error: 'PAYMENT_FAILED' satisfies FailureCode, message: 'No funded order found on-chain for this job.' });
    if (co.buyer !== q.buyerAccountId || co.provider !== q.providerAccountId || co.quote_digest !== q.quoteDigest) {
      return reply.code(409).send({ error: 'PAYMENT_FAILED' satisfies FailureCode, message: 'On-chain order does not match the quote.' });
    }
    if (BigInt(co.max_pay) < BigInt(q.maxPayYoctoNear) || co.status !== 'funded') {
      return reply.code(409).send({ error: 'PAYMENT_FAILED' satisfies FailureCode, message: 'Order is underfunded or not in Funded state.' });
    }
    const now = Date.now();
    const rec: OrderRecord = {
      jobId: q.jobId, quoteId: q.quoteId, offerId: q.offerId, buyerAccountId: q.buyerAccountId, providerAccountId: q.providerAccountId,
      status: 'funded', amountYoctoNear: co.max_pay, fundTxHash: body.fundTxHash,
      timeline: [{ at: now, event: 'quoted' }, { at: now, event: 'funded' }], createdAtMs: now, updatedAtMs: now,
    };
    await store.putOrder(rec);
    return reply.code(201).send({ receipt: receipt(rec), deadlineMs: co.deadline_ms });
  });

  app.get('/v1/orders', async (req) => {
    const { buyer, limit } = (req.query ?? {}) as { buyer?: string; limit?: string };
    const rows = await store.listOrders(Math.min(200, Number(limit) || 100));
    return { orders: rows.filter((o) => !buyer || o.buyerAccountId === buyer).map(receipt) };
  });
  // ---------------------------------------------------------------- marketplace, agents, activity
  app.get('/v1/marketplace', async () => {
    const [offers, orders] = await Promise.all([liveOffers(), store.listOrders(1000)]);
    return {
      offers: offers.map((o) => {
        const mine = orders.filter((x) => x.offerId === o.id);
        const c = (st: string) => mine.filter((x) => x.status === st).length;
        const done = c('settled') + c('rejected') + c('refunded');
        return { ...o, stats: { jobs: mine.length, settled: c('settled'), rejected: c('rejected') + c('refunded'), inProgress: c('funded'), successRate: done ? c('settled') / done : null, agents: new Set(mine.map((x) => x.buyerAccountId)).size } };
      }),
      policy: VERIFICATION_POLICY.id,
    };
  });

  const agentView = async (a: AgentRecord, orders: Awaited<ReturnType<Store['listOrders']>>) => {
    const mine = orders.filter((o) => o.buyerAccountId === a.accountId);
    const { spent } = await spentLast24h(a.accountId);
    return { ...a, usage: { spent24hYocto: spent.toString(), jobs: mine.length, settled: mine.filter((o) => o.status === 'settled').length, rejected: mine.filter((o) => o.status === 'rejected' || o.status === 'refunded').length, lastJobAtMs: mine[0]?.createdAtMs ?? null } };
  };

  app.get('/v1/agents', async () => {
    const [agents, orders] = await Promise.all([store.listAgents(), store.listOrders(1000)]);
    return { agents: await Promise.all(agents.map((a) => agentView(a, orders))), blockedByPolicy: counters.blocked };
  });

  /** Quotes refused by an agent's own spending policy: shown next to jobs in the operator's activity feed. */
  app.get('/v1/policy-events', async (req) => {
    const { accountId } = (req.query ?? {}) as { accountId?: string };
    return { events: policyEvents.filter((e) => !accountId || e.accountId === accountId).slice(0, 100) };
  });

  app.get('/v1/agents/:accountId', async (req, reply) => {
    const a = await store.getAgent((req.params as any).accountId);
    if (!a) return reply.code(404).send({ error: 'AGENT_NOT_FOUND' });
    return { agent: await agentView(a, await store.listOrders(1000)) };
  });

  /** Register or update an agent. The request is signed with a key of the agent's own NEAR account. */
  app.post('/v1/agents', async (req, reply) => {
    const body = parse(AgentRegister, req.body);
    if (Math.abs(Date.now() - body.timestampMs) > 5 * 60_000) return reply.code(400).send({ error: 'INVALID_REQUEST', message: 'Signature timestamp is too old or in the future.' });
    if (BigInt(body.policy.maxPerJobYocto) > BigInt(body.policy.dailyCapYocto)) return reply.code(400).send({ error: 'INVALID_REQUEST', message: 'Per-job cap cannot exceed the daily cap.' });
    let ok = false;
    try {
      const pk = PublicKey.fromString(body.publicKey);
      const key = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(pk.data)]), format: 'der', type: 'spki' });
      ok = edVerify(null, Buffer.from(agentMessage(body)), key, Buffer.from(body.signature, 'hex'));
    } catch { ok = false; }
    if (!ok) return reply.code(401).send({ error: 'BAD_SIGNATURE', message: 'Signature does not verify for this public key.' });
    if (!(await keyBelongs(body.accountId, body.publicKey))) return reply.code(401).send({ error: 'KEY_NOT_ON_ACCOUNT', message: 'That public key is not an access key of this NEAR account.' });
    const prev = await store.getAgent(body.accountId);
    const now = Date.now();
    const rec: AgentRecord = { accountId: body.accountId, name: body.name, policy: body.policy, createdAtMs: prev?.createdAtMs ?? now, updatedAtMs: now };
    await store.putAgent(rec);
    return reply.code(prev ? 200 : 201).send({ agent: await agentView(rec, await store.listOrders(1000)) });
  });


  app.get('/v1/orders/:jobId', async (req, reply) => {
    const rec = await store.getOrder((req.params as any).jobId);
    if (!rec) return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });
    const r = await refresh(rec);
    return { receipt: receipt(r), timeline: r.timeline };
  });

  app.get('/v1/receipts/:jobId', async (req, reply) => {
    const rec = await store.getOrder((req.params as any).jobId);
    if (!rec) return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });
    return { receipt: receipt(await refresh(rec)), trust: TRUST };
  });

  async function settleOnChain(rec: OrderRecord, outcome: 'verified' | 'rejected', result: VerifierResult, failure?: FailureCode) {
    const proofDigest = result.proofDigest ?? createHash('sha256').update(JSON.stringify(result.checks)).digest('hex');
    const binding = result.requestBindingDigest ?? createHash('sha256').update(`${rec.jobId}|rejected`).digest('hex');
    const verdict = makeVerdict(rec.jobId, outcome, proofDigest, binding);
    const signature_hex = signVerdict(verdict);
    const res = await relayer().callFunctionRaw({
      contractId: config.ESCROW_CONTRACT_ID, methodName: 'settle_order', args: { verdict, signature_hex }, gas: 100_000_000_000_000n,
    });
    const ok = typeof res.status === 'object' && res.status !== null && 'SuccessValue' in (res.status as any);
    if (!ok) throw Object.assign(new Error('settle_order failed on-chain'), { statusCode: 502, code: 'PAYMENT_FAILED' });
    rec.settleTxHash = txHashOf(res);
    rec.proofDigest = proofDigest;
    rec.verdictKeyId = verdict.verifier_key_id;
    rec.outcome = outcome;
    rec.status = outcome === 'verified' ? 'settled' : 'rejected';
    rec.failureCode = failure;
    rec.timeline.push({ at: Date.now(), event: outcome === 'verified' ? 'verified' : 'verifier_rejected' }, { at: Date.now(), event: rec.status });
    rec.updatedAtMs = Date.now();
    const co = await chainOrder(rec.jobId).catch(() => undefined);
    if (co?.fee_amount) rec.protocolFeeYoctoNear = co.fee_amount;
    await store.putOrder(rec);
  }

  app.post('/v1/orders/:jobId/proof', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const rec = await store.getOrder(jobId);
    if (!rec) return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });
    const current = await refresh(rec);
    if (current.status !== 'funded') return { receipt: receipt(current), idempotent: true, message: `Order already ${current.status}; no second settlement.` };
    const bundle = ProofBundle.parse(req.body); // allowlisted public shape; unknown fields rejected
    const offer = OFFERS.find((o) => o.id === rec.offerId)!;
    if (!(await store.claimNonce(bundle.preflight.nonce.toLowerCase(), jobId))) {
      return reply.code(409).send({ error: 'ATTESTATION_INVALID' satisfies FailureCode, message: 'Nonce was already used by another job (replay).' });
    }
    const result = await verifyProofBundle(bundle, { jobId, offerId: rec.offerId, model: offer.modelId });
    await settleOnChain(rec, result.ok ? 'verified' : 'rejected', result, result.ok ? undefined : (result.failureCode ?? 'VERIFIER_REJECTED'));
    return { receipt: receipt(rec), verification: { ok: result.ok, failureCode: result.failureCode ?? null, checks: result.checks, tcbStatus: result.tcbStatus ?? null, signer: result.signer ?? null }, trust: TRUST };
  });

  /** Client-reported pre-disclosure failure. The verifier only signs "rejected" if it reproduces the failure. */
  app.post('/v1/orders/:jobId/reject', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const rec = await store.getOrder(jobId);
    if (!rec) return reply.code(404).send({ error: 'ORDER_NOT_FOUND' });
    const current = await refresh(rec);
    if (current.status !== 'funded') return { receipt: receipt(current), idempotent: true };
    const body = ClientReject.parse(req.body);
    if (!body.bundle) {
      return reply.code(409).send({ error: body.reason, message: 'No independently checkable evidence. Funds are not released; the buyer can call request_refund on the contract after the deadline, without this backend.' });
    }
    const offer = OFFERS.find((o) => o.id === rec.offerId)!;
    const result = await verifyProofBundle(body.bundle, { jobId, offerId: rec.offerId, model: offer.modelId });
    if (result.ok) return reply.code(409).send({ error: 'VERIFIER_REJECTED', message: 'The verifier could not reproduce the failure; the evidence is valid. No rejected verdict issued.' });
    await settleOnChain(rec, 'rejected', result, result.failureCode ?? 'ATTESTATION_INVALID');
    return { receipt: receipt(rec), verification: { ok: false, failureCode: result.failureCode, checks: result.checks }, trust: TRUST };
  });

  // Public GPU evidence relay: browsers cannot reach NVIDIA NRAS (no CORS). Fixed upstream only; carries no user data.
  app.post('/v1/relay/nras', { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const r = await fetch('https://nras.attestation.nvidia.com/v3/attest/gpu', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(req.body), signal: AbortSignal.timeout(30_000) });
    return reply.code(r.status).header('content-type', 'application/json').send(await r.text());
  });
  app.get('/v1/relay/nras-jwks', async (_req, reply) => {
    const r = await fetch('https://nras.attestation.nvidia.com/.well-known/jwks.json', { signal: AbortSignal.timeout(15_000) });
    return reply.code(r.status).header('content-type', 'application/json').send(await r.text());
  });

  // Testnet convenience: tiny drip so a fresh browser burner wallet can fund an order. Disabled unless DRIP_ENABLED=true.
  const dripped = new Set<string>();
  app.post('/v1/dev/drip', async (req, reply) => {
    if (process.env.DRIP_ENABLED !== 'true') return reply.code(404).send({ error: 'DISABLED' });
    const { accountId } = z.object({ accountId: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    if (dripped.has(accountId)) return reply.code(429).send({ error: 'ALREADY_DRIPPED', message: 'This account already received testnet NEAR. Use https://near-faucet.io or https://docs.near.org/getting-started/faucet for more.' });
    dripped.add(accountId);
    const res: any = await relayer().transfer({ receiverId: accountId, amount: 10n ** 24n });
    return { txHash: txHashOf(res), amountNear: '1', explorer: explorerTx(txHashOf(res)) };
  });

  return app;
}
