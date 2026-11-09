import pg from 'pg';
import { config } from './config.js';
import type { OrderStatus } from './schemas.js';

/** Only public order metadata is ever persisted. No prompt, document, completion or raw attestation. */
export type QuoteRecord = {
  quoteId: string;
  jobId: string;
  offerId: string;
  modelId: string;
  buyerAccountId: string;
  providerAccountId: string;
  maxPayYoctoNear: string;
  depositYoctoNear: string;
  deadlineMs: number;
  expiresAtMs: number;
  quoteDigest: string;
  escrowContractId: string;
  createdAtMs: number;
};

export type AgentPolicy = { maxPerJobYocto: string; dailyCapYocto: string; allowedOffers: string[] };
export type AgentRecord = { accountId: string; name: string; policy: AgentPolicy; createdAtMs: number; updatedAtMs: number };

export type OrderRecord = {
  jobId: string;
  quoteId: string;
  offerId: string;
  buyerAccountId: string;
  providerAccountId: string;
  status: OrderStatus;
  amountYoctoNear: string;
  protocolFeeYoctoNear?: string;
  fundTxHash?: string;
  settleTxHash?: string;
  proofDigest?: string;
  verdictKeyId?: string;
  outcome?: 'verified' | 'rejected';
  failureCode?: string;
  timeline: { at: number; event: string }[];
  createdAtMs: number;
  updatedAtMs: number;
};

export interface Store {
  kind: 'postgres' | 'memory';
  init(): Promise<void>;
  putQuote(q: QuoteRecord): Promise<void>;
  getQuote(id: string): Promise<QuoteRecord | undefined>;
  putOrder(o: OrderRecord): Promise<void>;
  getOrder(jobId: string): Promise<OrderRecord | undefined>;
  listOrders(limit: number): Promise<OrderRecord[]>;
  /** Returns false when the nonce was already used (replay protection across jobs). */
  claimNonce(nonce: string, jobId: string): Promise<boolean>;
  putAgent(a: AgentRecord): Promise<void>;
  getAgent(accountId: string): Promise<AgentRecord | undefined>;
  listAgents(): Promise<AgentRecord[]>;
  listQuotesBy(accountId: string, sinceMs: number): Promise<QuoteRecord[]>;
  ping(): Promise<boolean>;
}

export class MemoryStore implements Store {
  kind = 'memory' as const;
  q = new Map<string, QuoteRecord>();
  o = new Map<string, OrderRecord>();
  n = new Map<string, string>();
  ag = new Map<string, AgentRecord>();
  async putAgent(a: AgentRecord) { this.ag.set(a.accountId, a); }
  async getAgent(id: string) { return this.ag.get(id); }
  async listAgents() { return [...this.ag.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs); }
  async listQuotesBy(id: string, since: number) { return [...this.q.values()].filter((q) => q.buyerAccountId === id && q.createdAtMs > since); }
  async init() {}
  async putQuote(q: QuoteRecord) { this.q.set(q.quoteId, q); }
  async getQuote(id: string) { return this.q.get(id); }
  async putOrder(o: OrderRecord) { this.o.set(o.jobId, o); }
  async getOrder(id: string) { return this.o.get(id); }
  async listOrders(limit: number) { return [...this.o.values()].sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, limit); }
  async claimNonce(nonce: string, jobId: string) {
    const prev = this.n.get(nonce);
    if (prev && prev !== jobId) return false;
    this.n.set(nonce, jobId);
    return true;
  }
  async ping() { return true; }
}

export class PgStore implements Store {
  kind = 'postgres' as const;
  pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 5, ssl: /railway|sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS quotes (quote_id TEXT PRIMARY KEY, doc JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE IF NOT EXISTS orders (job_id TEXT PRIMARY KEY, doc JSONB NOT NULL, created_ms BIGINT NOT NULL, updated_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE IF NOT EXISTS agents (account_id TEXT PRIMARY KEY, doc JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE IF NOT EXISTS used_nonces (nonce TEXT PRIMARY KEY, job_id TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
    `);
  }
  async putQuote(q: QuoteRecord) {
    await this.pool.query('INSERT INTO quotes(quote_id, doc) VALUES($1,$2) ON CONFLICT (quote_id) DO NOTHING', [q.quoteId, q]);
  }
  async getQuote(id: string) {
    return (await this.pool.query('SELECT doc FROM quotes WHERE quote_id=$1', [id])).rows[0]?.doc;
  }
  async putOrder(o: OrderRecord) {
    await this.pool.query(
      'INSERT INTO orders(job_id, doc, created_ms) VALUES($1,$2,$3) ON CONFLICT (job_id) DO UPDATE SET doc=$2, updated_at=now()',
      [o.jobId, o, o.createdAtMs],
    );
  }
  async getOrder(id: string) {
    return (await this.pool.query('SELECT doc FROM orders WHERE job_id=$1', [id])).rows[0]?.doc;
  }
  async listOrders(limit: number) {
    return (await this.pool.query('SELECT doc FROM orders ORDER BY created_ms DESC LIMIT $1', [limit])).rows.map((r) => r.doc);
  }
  async claimNonce(nonce: string, jobId: string) {
    const r = await this.pool.query('INSERT INTO used_nonces(nonce, job_id) VALUES($1,$2) ON CONFLICT (nonce) DO NOTHING RETURNING job_id', [nonce, jobId]);
    if (r.rowCount) return true;
    return (await this.pool.query('SELECT job_id FROM used_nonces WHERE nonce=$1', [nonce])).rows[0]?.job_id === jobId;
  }
  async putAgent(a: AgentRecord) {
    await this.pool.query('INSERT INTO agents(account_id, doc) VALUES($1,$2) ON CONFLICT (account_id) DO UPDATE SET doc=$2, updated_at=now()', [a.accountId, a]);
  }
  async getAgent(id: string) { return (await this.pool.query('SELECT doc FROM agents WHERE account_id=$1', [id])).rows[0]?.doc; }
  async listAgents() { return (await this.pool.query('SELECT doc FROM agents ORDER BY updated_at DESC LIMIT 200')).rows.map((r) => r.doc); }
  async listQuotesBy(id: string, since: number) {
    return (await this.pool.query("SELECT doc FROM quotes WHERE doc->>'buyerAccountId' = $1 AND (doc->>'createdAtMs')::bigint > $2", [id, since])).rows.map((r) => r.doc);
  }
  async ping() {
    try { await this.pool.query('SELECT 1'); return true; } catch { return false; }
  }
}

export function createStore(): Store {
  return config.DATABASE_URL ? new PgStore(config.DATABASE_URL) : new MemoryStore();
}
