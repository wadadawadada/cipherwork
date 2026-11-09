import * as nodeSdk from '@nearai/inference-sdk/node';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from 'near-api-js';
import { buildProofBundle, preflight, runPrivateInference, type FaultInjection, type Preflight, type PrivateResult } from './privateJob.js';

export * from './privateJob.js';

export type ClientOptions = {
  apiUrl: string;
  nearAiBaseUrl?: string;
  nearAiApiKey?: string;
  buyerAccountId?: string;
  buyerPrivateKey?: string;
  rpcUrl?: string;
  onEvent?: (e: { step: string; detail?: string }) => void;
};

/** TypeScript client for the CIPHERWORK workflow. Private input only ever goes buyer -> verified TEE. */
export class CipherworkClient {
  constructor(public opts: ClientOptions) {}
  private emit(step: string, detail?: string) { this.opts.onEvent?.({ step, detail }); }

  private async api<T = any>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetch(this.opts.apiUrl + path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.message ?? j.error ?? `HTTP ${r.status}`), { code: j.error, status: r.status, body: j });
    return j;
  }

  discover() { return this.api('/v1/products/private_ai_inference.v1/offers'); }
  quote(offerId: string, buyerAccountId = this.opts.buyerAccountId!) {
    return this.api('/v1/quotes', { method: 'POST', body: JSON.stringify({ productId: 'private_ai_inference.v1', offerId, buyerAccountId }) });
  }

  /** Public attestation only; no key and no user data. */
  verifyProvider(model: string, fault: FaultInjection = 'none') {
    return preflight(nodeSdk as any, { baseUrl: this.opts.nearAiBaseUrl ?? 'https://cloud-api.near.ai/v1', model, fault, onCheck: (c) => this.emit('preflight', `${c.status}: ${c.label}`) });
  }

  private buyer() {
    return new Account(this.opts.buyerAccountId!, new JsonRpcProvider({ url: this.opts.rpcUrl ?? 'https://test.rpc.fastnear.com' }), KeyPairSigner.fromSecretKey(this.opts.buyerPrivateKey as `ed25519:${string}`));
  }

  async fundOrder(q: any) {
    const res = await this.buyer().callFunctionRaw({
      contractId: q.quote.escrowContractId, methodName: 'create_order',
      args: { order_id: q.quote.jobId, provider_id: q.quote.providerAccountId, deadline_ms: q.quote.deadlineMs, quote_digest: q.quote.quoteDigest },
      deposit: BigInt(q.quote.depositYoctoNear), gas: 60_000_000_000_000n,
    });
    const hash = (res as any).transaction.hash as string;
    const created = await this.api('/v1/orders', { method: 'POST', body: JSON.stringify({ jobId: q.quote.jobId, quoteId: q.quote.quoteId, fundTxHash: hash }) });
    return { txHash: hash, ...created };
  }

  async runPrivateInference(model: string, pf: Preflight, messages: { role: 'system' | 'user'; content: string }[]): Promise<PrivateResult> {
    return runPrivateInference(nodeSdk as any, {
      baseUrl: this.opts.nearAiBaseUrl ?? 'https://cloud-api.near.ai/v1', apiKey: this.opts.nearAiApiKey!, model, preflight: pf, messages,
    });
  }

  /** Register or update this agent's spending policy. Signed with the agent's own NEAR key; enforced by the API at quote time. */
  async registerAgent(args: { name: string; maxPerJobYocto: string; dailyCapYocto: string; allowedOffers?: string[] }) {
    const policy = { maxPerJobYocto: args.maxPerJobYocto, dailyCapYocto: args.dailyCapYocto, allowedOffers: args.allowedOffers ?? [] };
    const accountId = this.opts.buyerAccountId!, timestampMs = Date.now();
    const msg = `cipherwork.agent.v1|${accountId}|${args.name}|${JSON.stringify(policy)}|${timestampMs}`;
    const kp = KeyPair.fromString(this.opts.buyerPrivateKey as `ed25519:${string}`);
    const sig = kp.sign(new TextEncoder().encode(msg));
    const signature = Buffer.from(sig.signature).toString('hex');
    return this.api('/v1/agents', { method: 'POST', body: JSON.stringify({ accountId, name: args.name, policy, timestampMs, publicKey: kp.getPublicKey().toString(), signature }) });
  }
  marketplace() { return this.api('/v1/marketplace'); }

  submitVerdict(jobId: string, bundle: unknown) {
    return this.api(`/v1/orders/${jobId}/proof`, { method: 'POST', body: JSON.stringify(bundle) });
  }
  getReceipt(jobId: string) { return this.api(`/v1/receipts/${jobId}`); }

  /** End-to-end: discover -> quote -> fund -> preflight -> private run -> verify -> settle -> receipt. */
  async executePrivateJob(args: { offerId: string; messages: { role: 'system' | 'user'; content: string }[] }) {
    const offers = await this.discover();
    const offer = offers.offers.find((o: any) => o.id === args.offerId);
    if (!offer || offer.status !== 'available') throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { code: 'PROVIDER_UNAVAILABLE' });
    this.emit('quote', offer.label);
    const q = await this.quote(args.offerId);
    this.emit('fund', `${q.quote.depositYoctoNear} yoctoNEAR`);
    const funded = await this.fundOrder(q);
    this.emit('preflight', offer.modelId);
    const pf = await this.verifyProvider(offer.modelId); // throws PreflightError -> nothing sent
    this.emit('private-run', 'preflight passed; sending E2EE input to attested model');
    const result = await this.runPrivateInference(offer.modelId, pf, args.messages);
    this.emit('verify', result.signatureKind);
    const settled = await this.submitVerdict(q.quote.jobId, buildProofBundle({ jobId: q.quote.jobId, offerId: args.offerId, model: offer.modelId, preflight: pf, result }));
    this.emit('receipt', settled.receipt.status);
    return { jobId: q.quote.jobId, answer: result.answer, funded, preflight: pf, result, settled };
  }
}
